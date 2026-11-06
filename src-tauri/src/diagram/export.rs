//! Renders a standalone SVG (made by the frontend's generator) to PNG and PDF, and writes the
//! results to files (`save_with`, `save_png`, `sweep_print_files`). No database, no Tauri: the
//! commands that call it, which pick the paths, are in `mod.rs`.

use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::time::{Duration, SystemTime};
use std::sync::{Arc, OnceLock};

use krilla_svg::{SurfaceExt, SvgSettings};
use serde::{Deserialize, Serialize};

/// Past this many pixels a PNG is refused (the dialog warns well before).
pub const MAX_PNG_PIXELS: u64 = 1_000_000_000;
/// The longest side of a PDF page, in points (the PDF format's own limit).
pub const MAX_PAGE_PT: f32 = 14_400.0;

/// Rows rendered at a time, so a huge PNG never holds more than one strip of pixels.
const STRIP: u32 = 256;

/// One PDF page: its own SVG, the page size and the margin around it, all in points.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPage {
    pub svg: String,
    pub width_pt: f32,
    pub height_pt: f32,
    pub margin_pt: f32,
}

/// What the frontend sends: the format and what to render.
#[derive(Debug, Deserialize)]
#[serde(tag = "format", rename_all = "kebab-case")]
pub enum ExportRequest {
    Svg { svg: String },
    Png { svg: String, scale: f32 },
    Pdf { pages: Vec<PdfPage> },
}

/// Sent over the command's channel as strips or pages finish.
#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub done: u32,
    pub total: u32,
}

/// A name that is safe on every platform: no path separators or characters Windows
/// refuses, and never empty.
pub fn file_name(name: &str, extension: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .take(100)
        .collect();
    // Windows drops trailing dots and spaces.
    let cleaned = cleaned.trim().trim_end_matches('.');
    let stem = if cleaned.is_empty() { "diagram" } else { cleaned };
    format!("{stem}.{extension}")
}

/// Deletes files in `dir` last modified before `older_than` ago. Best effort: it only
/// tidies the app's own print folder, so a file that can't be removed is left.
pub fn sweep_print_files(dir: &Path, older_than: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > older_than);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// It's the user's file, as in `external::write`: a symlink keeps pointing where it did and
/// an existing file keeps its permissions.
fn save_with(path: &Path, write: impl FnOnce(&mut fs::File) -> io::Result<()>) -> Result<(), String> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let permissions = fs::metadata(&target).ok().map(|m| m.permissions());
    crate::fsutil::write_atomic_with(&target, permissions, write)
        .map_err(|e| format!("Could not save {}: {e}", path.display()))
}

pub fn save_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    save_with(path, |file| file.write_all(bytes))
}

/// Streams the PNG into a temp file, so a render that fails leaves the target as it was.
pub fn save_png(path: &Path, tree: &usvg::Tree, scale: f32, progress: &mut dyn FnMut(u32, u32)) -> Result<(), String> {
    let mut failure = None;
    let saved = save_with(path, |file| {
        let mut out = BufWriter::new(file);
        write_png(tree, scale, &mut out, progress)
            .map_err(|e| {
                failure = Some(e);
                io::Error::other("render failed")
            })
            .and_then(|()| out.flush())
    });
    match failure {
        Some(reason) => Err(reason),
        None => saved,
    }
}

/// Faces that draw a missing character badly: LastResort shows a box for a whole line, and
/// Arial Unicode MS shapes Devanagari and Tamil wrongly while being first in the list.
fn is_poor_fallback(post_script_name: &str) -> bool {
    post_script_name.contains("LastResort") || post_script_name.starts_with("ArialUnicode")
}

/// Bundled Inter first, so it wins over a system copy, then the system's fonts for scripts
/// Inter lacks. Loaded once, on the first export.
fn fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = usvg::fontdb::Database::new();
            db.load_font_data(include_bytes!("../../fonts/Inter-Regular.ttf").to_vec());
            db.load_font_data(include_bytes!("../../fonts/Inter-SemiBold.ttf").to_vec());
            db.load_system_fonts();
            let poor: Vec<_> = db
                .faces()
                .filter(|f| is_poor_fallback(&f.post_script_name))
                .map(|f| f.id)
                .collect();
            for id in poor {
                db.remove_face(id);
            }
            db.set_sans_serif_family("Inter");
            Arc::new(db)
        })
        .clone()
}

/// Parses the generator's SVG. Images are never read, from a path or a data URL.
pub fn parse(svg: &str) -> Result<usvg::Tree, String> {
    let options = usvg::Options {
        fontdb: fonts(),
        font_family: "Inter".into(),
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    };
    usvg::Tree::from_str(svg, &options).map_err(|e| format!("The diagram's SVG is invalid: {e}"))
}

/// The PNG's size in pixels at this scale, or why it can't be made.
pub fn png_size(tree: &usvg::Tree, scale: f32) -> Result<(u32, u32), String> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err("The scale must be a positive number.".into());
    }
    // Float casts saturate, so a huge scale gives u64::MAX: bound each side by u32 first, which
    // also keeps the product from overflowing and the final casts from truncating.
    let w = (tree.size().width() * scale).ceil() as u64;
    let h = (tree.size().height() * scale).ceil() as u64;
    if w == 0 || h == 0 {
        return Err("The diagram is empty.".into());
    }
    let sides_fit = w <= u32::MAX as u64 && h <= u32::MAX as u64;
    if !sides_fit || w * h > MAX_PNG_PIXELS {
        let total = if sides_fit { format!(" ({} in all)", w * h) } else { String::new() };
        return Err(format!(
            "The image would be {w} x {h} pixels{total}, past the limit of {MAX_PNG_PIXELS}. Use a smaller scale."
        ));
    }
    Ok((w as u32, h as u32))
}

/// Renders in strips, streaming each into the encoder. `progress` gets (strips done, strips).
pub fn write_png(
    tree: &usvg::Tree,
    scale: f32,
    out: impl Write,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<(), String> {
    let (width, height) = png_size(tree, scale)?;
    let mut encoder = png::Encoder::new(out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    let mut stream = writer.stream_writer().map_err(|e| e.to_string())?;
    let total = height.div_ceil(STRIP);
    let mut y = 0;
    let mut done = 0;
    while y < height {
        let rows = STRIP.min(height - y);
        let mut pixmap = resvg::tiny_skia::Pixmap::new(width, rows)
            .ok_or("Not enough memory for the image.")?;
        let transform = resvg::tiny_skia::Transform::from_scale(scale, scale)
            .post_translate(0.0, -(y as f32));
        resvg::render(tree, transform, &mut pixmap.as_mut());
        // The pixels are premultiplied, which equals straight alpha only because the
        // generator paints an opaque background, so nothing needs demultiplying.
        stream.write_all(pixmap.data()).map_err(|e| e.to_string())?;
        y += rows;
        done += 1;
        progress(done, total);
    }
    stream.finish().map_err(|e| e.to_string())
}

/// One PDF, a page per entry, text kept as text. `progress` gets (pages done, pages).
pub fn pdf(pages: &[PdfPage], progress: &mut dyn FnMut(u32, u32)) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("There is nothing to export.".into());
    }
    for p in pages {
        let sides = [p.width_pt, p.height_pt];
        if sides.iter().any(|s| !s.is_finite() || *s <= 0.0 || *s > MAX_PAGE_PT) {
            return Err(format!("A page can be at most {MAX_PAGE_PT} points on a side."));
        }
        if !p.margin_pt.is_finite()
            || p.margin_pt < 0.0
            || p.margin_pt * 2.0 >= p.width_pt.min(p.height_pt)
        {
            return Err("The margin leaves no room on the page.".into());
        }
    }
    let total = pages.len() as u32;
    let mut doc = krilla::Document::new();
    for (i, p) in pages.iter().enumerate() {
        let tree = parse(&p.svg)?;
        let page_size = krilla::geom::Size::from_wh(p.width_pt, p.height_pt)
            .ok_or("A page has no size.")?;
        let inner = krilla::geom::Size::from_wh(
            p.width_pt - 2.0 * p.margin_pt,
            p.height_pt - 2.0 * p.margin_pt,
        )
        .ok_or("The margin leaves no room on the page.")?;
        let mut page = doc.start_page_with(krilla::page::PageSettings::new(page_size));
        let mut surface = page.surface();
        surface.push_transform(&krilla::geom::Transform::from_translate(
            p.margin_pt,
            p.margin_pt,
        ));
        surface
            .draw_svg(&tree, inner, SvgSettings::default())
            .ok_or("A page could not be drawn.")?;
        surface.pop();
        surface.finish();
        page.finish();
        progress(i as u32 + 1, total);
    }
    doc.finish().map_err(|e| format!("The PDF could not be written: {e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOX: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50" fill="#fff"/></svg>"##;

    fn decode(bytes: &[u8]) -> (png::OutputInfo, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        (info, buf)
    }

    fn texts(group: &usvg::Group, out: &mut Vec<(String, f32)>) {
        for node in group.children() {
            match node {
                usvg::Node::Group(g) => texts(g, out),
                usvg::Node::Text(t) => {
                    let s: String = t.chunks().iter().map(|c| c.text().to_string()).collect();
                    out.push((s, t.bounding_box().width()));
                }
                _ => {}
            }
        }
    }

    fn has_image(group: &usvg::Group) -> bool {
        group.children().iter().any(|n| match n {
            usvg::Node::Image(_) => true,
            usvg::Node::Group(g) => has_image(g),
            _ => false,
        })
    }

    #[test]
    fn an_image_is_never_read() {
        let file = r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image href="/etc/hosts" width="10" height="10"/></svg>"#;
        let data = r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="/></svg>"#;
        for svg in [file, data] {
            let tree = parse(svg).unwrap();
            assert!(!has_image(tree.root()));
        }
    }

    #[test]
    fn a_bad_document_is_an_error_not_a_panic() {
        assert!(parse("<svg><x").is_err());
    }

    #[test]
    fn text_measures_as_the_canvas_does() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100">
<text x="0" y="20" font-family="Inter" font-size="11" font-weight="600">public.order_items</text>
<text x="0" y="50" font-family="Inter" font-size="10" font-weight="400">orders_customer_id_fkey</text></svg>"#;
        let tree = parse(svg).unwrap();
        let mut out = vec![];
        texts(tree.root(), &mut out);
        let width = |s: &str| out.iter().find(|(t, _)| t == s).unwrap().1;
        assert!((width("public.order_items") - 99.2).abs() < 0.1);
        assert!((width("orders_customer_id_fkey") - 117.8).abs() < 0.1);
    }

    #[test]
    fn poor_fallback_fonts_are_dropped() {
        assert!(is_poor_fallback("LastResort"));
        assert!(is_poor_fallback("ArialUnicodeMS"));
        assert!(!is_poor_fallback("PingFangSC-Regular"));
        assert!(!is_poor_fallback("Inter-Regular"));
    }

    #[test]
    fn a_png_has_the_scaled_size() {
        let tree = parse(BOX).unwrap();
        assert_eq!(png_size(&tree, 3.0).unwrap(), (300, 150));
        let mut bytes = vec![];
        write_png(&tree, 3.0, &mut bytes, &mut |_, _| {}).unwrap();
        let (info, buf) = decode(&bytes);
        assert_eq!((info.width, info.height), (300, 150));
        assert_eq!(&buf[..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn png_rows_cross_strips_without_a_seam() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="600"><rect width="20" height="300" fill="#f00"/><rect y="300" width="20" height="300" fill="#00f"/></svg>"##;
        let tree = parse(svg).unwrap();
        let mut bytes = vec![];
        write_png(&tree, 1.0, &mut bytes, &mut |_, _| {}).unwrap();
        let (info, buf) = decode(&bytes);
        let row = |y: usize| &buf[y * info.line_size..(y + 1) * info.line_size];
        assert!(row(299).chunks(4).all(|p| p == [255, 0, 0, 255]));
        assert!(row(300).chunks(4).all(|p| p == [0, 0, 255, 255]));
    }

    #[test]
    fn a_huge_png_is_refused_before_any_work() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="80000" height="40000" viewBox="0 0 80000 40000"/>"#;
        let tree = parse(svg).unwrap();
        let err = png_size(&tree, 1.0).unwrap_err();
        assert!(err.contains("3200000000"), "{err}");
        let mut bytes = vec![];
        assert!(write_png(&tree, 1.0, &mut bytes, &mut |_, _| {}).is_err());
        assert!(bytes.is_empty());
    }

    #[test]
    fn a_size_that_overflows_is_refused() {
        let tree = parse(BOX).unwrap();
        assert!(png_size(&tree, 1e30).is_err());
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="8589934592" height="2147483648" viewBox="0 0 8589934592 2147483648"/>"#;
        let tree = parse(svg).unwrap();
        assert!(png_size(&tree, 1.0).is_err());
    }

    #[test]
    fn a_bad_scale_is_refused() {
        let tree = parse(BOX).unwrap();
        for scale in [0.0, -1.0, f32::NAN] {
            assert!(png_size(&tree, scale).is_err());
        }
    }

    fn page(width_pt: f32) -> PdfPage {
        PdfPage { svg: BOX.into(), width_pt, height_pt: 200.0, margin_pt: 18.0 }
    }

    #[test]
    fn a_pdf_has_one_page_per_svg() {
        let bytes = pdf(&[page(300.0), page(300.0)], &mut |_, _| {}).unwrap();
        assert!(bytes.starts_with(b"%PDF"));
        assert!(String::from_utf8_lossy(&bytes).contains("/Count 2"));
    }

    #[test]
    fn a_page_past_the_limit_is_refused() {
        assert!(pdf(&[page(14_401.0)], &mut |_, _| {}).is_err());
    }

    #[test]
    fn progress_reports_every_step() {
        let tree = parse(BOX).unwrap();
        let mut calls = vec![];
        write_png(&tree, 12.0, &mut vec![], &mut |d, t| calls.push((d, t))).unwrap();
        assert_eq!(calls.last(), Some(&(3, 3)));
        let mut calls = vec![];
        pdf(&[page(300.0), page(300.0)], &mut |d, t| calls.push((d, t))).unwrap();
        assert_eq!(calls.last(), Some(&(2, 2)));
    }

    #[test]
    fn a_file_name_is_safe() {
        assert_eq!(file_name("a/b:c", "png"), "a-b-c.png");
        assert_eq!(file_name("", "pdf"), "diagram.pdf");
        let name = file_name("con?*\u{0}", "svg");
        assert!(!name.contains(['?', '*', '\u{0}']), "{name}");
    }

    #[cfg(unix)]
    #[test]
    fn sweeping_removes_only_old_files() {
        use std::time::{Duration, SystemTime};
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.pdf");
        let new = dir.path().join("new.pdf");
        std::fs::write(&old, "x").unwrap();
        std::fs::write(&new, "x").unwrap();
        let two_days = SystemTime::now() - Duration::from_secs(2 * 86_400);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(two_days).unwrap();

        sweep_print_files(dir.path(), Duration::from_secs(86_400));

        assert!(!old.exists());
        assert!(new.exists());
    }

    /// Renders a request captured from the export dialog, for looking at and timing. The
    /// fixture is one `ExportRequest`'s JSON; the PNG and PDF land next to it.
    #[test]
    #[ignore]
    fn renders_a_captured_export() {
        // `cargo test -- --include-ignored` runs this too, with no fixture to render.
        let Ok(fixture) = std::env::var("HUXDB_EXPORT_FIXTURE") else {
            println!("HUXDB_EXPORT_FIXTURE is not set; nothing to render");
            return;
        };
        let fixture = std::path::PathBuf::from(fixture);
        let request: ExportRequest = serde_json::from_slice(&fs::read(&fixture).unwrap()).unwrap();
        let (svg, scale, pages) = match request {
            ExportRequest::Svg { svg } => (svg, 2.0, None),
            ExportRequest::Png { svg, scale } => (svg, scale, None),
            ExportRequest::Pdf { pages } => (pages[0].svg.clone(), 1.0, Some(pages)),
        };
        let start = std::time::Instant::now();
        let tree = parse(&svg).unwrap();
        println!("parse {:?}", start.elapsed());
        let start = std::time::Instant::now();
        save_png(&fixture.with_extension("png"), &tree, scale, &mut |_, _| {}).unwrap();
        println!("png at {scale}x {:?}", start.elapsed());
        let pages = pages.unwrap_or_else(|| {
            let (width, height) = (tree.size().width(), tree.size().height());
            let k = (MAX_PAGE_PT / width.max(height)).min(0.75);
            vec![PdfPage { svg, width_pt: width * k, height_pt: height * k, margin_pt: 0.0 }]
        });
        let start = std::time::Instant::now();
        let bytes = pdf(&pages, &mut |_, _| {}).unwrap();
        println!("pdf of {} pages {:?}, {} bytes", pages.len(), start.elapsed(), bytes.len());
        save_bytes(&fixture.with_extension("pdf"), &bytes).unwrap();
    }

    #[test]
    fn a_png_that_cannot_render_leaves_the_target_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        std::fs::write(&path, "old").unwrap();
        let tree = parse(BOX).unwrap();

        assert!(save_png(&path, &tree, 1.0e6, &mut |_, _| {}).is_err());

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
