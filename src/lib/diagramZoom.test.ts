import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, sliderFromZoom, stepZoom, zoomFromSlider, zoomLabel } from "./diagramZoom";

describe("slider", () => {
  it("reaches both ends", () => {
    expect(sliderFromZoom(MIN_ZOOM)).toBeCloseTo(0);
    expect(sliderFromZoom(MAX_ZOOM)).toBeCloseTo(100);
    expect(zoomFromSlider(0)).toBeCloseTo(MIN_ZOOM);
    expect(zoomFromSlider(100)).toBeCloseTo(MAX_ZOOM);
  });

  it("round-trips", () => {
    for (const zoom of [0.02, 0.1, 0.5, 1, 1.5]) expect(zoomFromSlider(sliderFromZoom(zoom))).toBeCloseTo(zoom);
  });

  it("gives low zooms real travel, unlike a linear scale", () => {
    expect(sliderFromZoom(0.1)).toBeGreaterThan(40);
  });

  it("copes with a zoom outside its range", () => {
    expect(sliderFromZoom(0.001)).toBe(0);
    expect(zoomFromSlider(500)).toBe(MAX_ZOOM);
  });
});

describe("stepZoom", () => {
  it("moves between steps", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
  });

  it("goes from between steps to the next one each way", () => {
    expect(stepZoom(0.6, 1)).toBe(0.75);
    expect(stepZoom(0.6, -1)).toBe(0.5);
  });

  it("stops at the ends", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("keeps zooming out below the lowest step, because a large diagram fits there", () => {
    expect(stepZoom(0.05, -1)).toBeCloseTo(0.0333, 3);
    expect(stepZoom(0.05, 1)).toBe(0.1);
  });
});

it("labels a zoom as a percentage", () => {
  expect(zoomLabel(0.043)).toBe("4%");
  expect(zoomLabel(1)).toBe("100%");
});
