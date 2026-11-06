import { Channel } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { exportDiagram, printDiagram } from "../../lib/api";
import { measureText } from "../../lib/diagramBrowser";
import { buildScene, hasHubLines, sceneSvg } from "../../lib/diagramExport";
import { MAX_PAGES_WIDE, PAPERS, PNG_SCALES, defaultOrientation, defaultPaper, exportSummary, fittedPage, tilePlan, tiledPages } from "../../lib/diagramExportPages";
import type { Orientation, PaperName } from "../../lib/diagramExportPages";
import type { DiagramExport, ExportProgress } from "../../lib/types";
import { useDiagrams } from "../../stores/diagram";
import { useTabs } from "../../stores/tabs";
import { Modal } from "../Modal";
import { Choice } from "./LayoutOptions";

type Format = "svg" | "png" | "pdf";
type PdfPages = "one" | "tiled";

const FORMATS: { value: Format; label: string }[] = [
  { value: "svg", label: "SVG" },
  { value: "png", label: "PNG" },
  { value: "pdf", label: "PDF" },
];
const PDF_PAGES: { value: PdfPages; label: string }[] = [
  { value: "one", label: "One Page" },
  { value: "tiled", label: "Tiled" },
];
const PAPER_CHOICES = (Object.keys(PAPERS) as PaperName[]).map((value) => ({ value, label: PAPERS[value].label }));
const ORIENTATIONS: { value: Orientation; label: string }[] = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];
const SCALES = PNG_SCALES.map((value) => ({ value, label: `${value}×` }));

/** Writes the diagram to a file, or opens it as a PDF. It reads the store once, so the diagram can't move under it. */
export function ExportDialog({ id, mode, onClose }: { id: string; mode: "export" | "print"; onClose: () => void }) {
  const print = mode === "print";
  const [input] = useState(() => {
    const d = useDiagrams.getState().diagrams[id];
    return d && d.options ? { nodes: d.nodes, edges: d.edges, annotations: d.annotations, colors: d.colors, options: d.options } : null;
  });
  const suggestedName = useTabs.getState().tabs.find((t) => t.id === id)?.name ?? "diagram";
  const hubs = useMemo(() => (input ? hasHubLines(input.edges) : false), [input]);

  const [format, setFormat] = useState<Format>("svg");
  const [scale, setScale] = useState(2);
  const [pdfPages, setPdfPages] = useState<PdfPages>("one");
  const [paper, setPaper] = useState<PaperName>(() => defaultPaper(navigator.language));
  const [chosenOrientation, setOrientation] = useState<Orientation | null>(null);
  const [pagesWide, setPagesWide] = useState("1");
  const [blackAndWhite, setBlackAndWhite] = useState(input?.options.blackAndWhite ?? false);
  const [hubLines, setHubLines] = useState(true);

  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scene = useMemo(() => (input ? buildScene(input, { blackAndWhite, hubLines: !hubs || hubLines }, measureText) : null), [input, blackAndWhite, hubLines, hubs]);
  const tiled = print || (format === "pdf" && pdfPages === "tiled");
  const orientation = chosenOrientation ?? (scene ? defaultOrientation(scene.bounds) : "portrait");
  const plan = useMemo(() => (scene ? tilePlan(scene.bounds, paper, orientation, Number(pagesWide)) : null), [scene, paper, orientation, pagesWide]);
  const summary = scene && plan ? exportSummary(scene.bounds, tiled ? { kind: "tiled", plan } : format === "png" ? { kind: "image", scale } : format === "pdf" ? { kind: "fitted" } : { kind: "vector" }) : null;

  const run = async () => {
    if (!scene || !plan) return;
    setBusy(true);
    setSaved(null);
    setError(null);
    setProgress(null);
    const channel = new Channel<ExportProgress>();
    channel.onmessage = setProgress;
    try {
      if (print) {
        await printDiagram(tiledPages(scene, plan), suggestedName, channel);
        setSaved("print");
      } else {
        const svg = format === "pdf" ? "" : sceneSvg(scene);
        const request: DiagramExport = format === "svg" ? { format, svg } : format === "png" ? { format, svg, scale } : { format, pages: tiled ? tiledPages(scene, plan) : [fittedPage(scene)] };
        const path = await exportDiagram(request, suggestedName, channel);
        if (path) setSaved(path);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal title={print ? "Print Diagram" : "Export Diagram"} onClose={onClose} dismissible={!busy} className="max-w-md">
      <div className="text-sm">
        {!print && <Choice label="Format" value={format} choices={FORMATS} onChange={setFormat} />}
        {!print && format === "png" && <Choice label="Scale" value={scale} choices={SCALES} onChange={setScale} />}
        {!print && format === "pdf" && <Choice label="Pages" value={pdfPages} choices={PDF_PAGES} onChange={setPdfPages} />}
        {tiled && (
          <>
            <Choice label="Paper" value={paper} choices={PAPER_CHOICES} onChange={setPaper} />
            <Choice label="Orientation" value={orientation} choices={ORIENTATIONS} onChange={setOrientation} />
            <label className="mb-3 flex items-center gap-2">
              Pages wide
              <input type="number" className="input input-xs w-20" min={1} max={MAX_PAGES_WIDE} step={1} value={pagesWide} onChange={(e) => setPagesWide(e.target.value)} />
            </label>
          </>
        )}
        <label className="mb-2 flex items-center gap-2">
          <input type="checkbox" className="checkbox checkbox-xs" checked={blackAndWhite} onChange={(e) => setBlackAndWhite(e.target.checked)} />
          Black and white
        </label>
        {hubs && (
          <label className="mb-2 flex items-center gap-2">
            <input type="checkbox" className="checkbox checkbox-xs" checked={hubLines} onChange={(e) => setHubLines(e.target.checked)} />
            Hub lines
          </label>
        )}
        {summary && (
          <div className="mt-3" aria-live="polite">
            <div>{summary.text}</div>
            {summary.warnings.map((w) => (
              <div key={w} className="text-warning">
                {w}
              </div>
            ))}
          </div>
        )}
        {busy && <progress className="progress progress-primary mt-3 w-full" value={progress?.done} max={progress?.total} />}
        {saved && <p className="mt-3 select-text">{saved === "print" ? "Opened in your PDF viewer. Print from there." : `Saved to ${saved}`}</p>}
        {error && <p className="mt-3 whitespace-pre-wrap text-error select-text">{error}</p>}
      </div>
      <div className="modal-action">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !scene || !!summary?.refuse} onClick={() => void run()}>
          {print ? "Print" : "Export"}
        </button>
      </div>
    </Modal>
  );
}
