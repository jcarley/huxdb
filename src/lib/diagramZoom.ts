// Zoom steps for a diagram's Overview. Pure.

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 2;
/** Where ⌘+ and ⌘− stop, and what the percentage select offers. */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
const SPAN = Math.log(MAX_ZOOM / MIN_ZOOM);

/** The slider runs 0 to 100 on a log scale, because a linear one spends nearly all its travel above 50%. */
export const sliderFromZoom = (zoom: number) => (Math.log(clamp(zoom) / MIN_ZOOM) / SPAN) * 100;
export const zoomFromSlider = (value: number) => clamp(MIN_ZOOM * Math.exp((value / 100) * SPAN));

/** The next step in that direction. From below the lowest step, zooming in reaches it. */
export function stepZoom(zoom: number, direction: 1 | -1) {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? clamp(zoom / 1.5);
}

export const zoomLabel = (zoom: number) => `${Math.round(zoom * 100)}%`;
