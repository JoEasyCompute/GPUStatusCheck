import { describe, expect, it } from "vitest";
import { panTimeWindow, zoomTimeWindow, type TimeWindow } from "../src/client/timeWindow";

const HOUR = 60 * 60 * 1000;
const full: TimeWindow = { min: 0, max: 10 * HOUR };

describe("zoomTimeWindow", () => {
  it("zooms in around the anchor fraction", () => {
    const window = zoomTimeWindow(full, undefined, 0.5, 0.5);
    expect(window).toEqual({ min: 2.5 * HOUR, max: 7.5 * HOUR });
  });

  it("keeps the anchor time fixed when zooming an existing window", () => {
    const current: TimeWindow = { min: 2 * HOUR, max: 6 * HOUR };
    const window = zoomTimeWindow(full, current, 0.25, 0.5)!;
    const anchor = 3 * HOUR;
    expect(window.min + 0.25 * (window.max - window.min)).toBeCloseTo(anchor);
    expect(window.max - window.min).toBeCloseTo(2 * HOUR);
  });

  it("returns undefined when zooming out to the full range", () => {
    const current: TimeWindow = { min: 2 * HOUR, max: 6 * HOUR };
    expect(zoomTimeWindow(full, current, 0.5, 100)).toBeUndefined();
    expect(zoomTimeWindow(full, undefined, 0.5, 2)).toBeUndefined();
  });

  it("clamps to the full range at the edges", () => {
    const current: TimeWindow = { min: 0, max: 4 * HOUR };
    const window = zoomTimeWindow(full, current, 0, 0.5)!;
    expect(window.min).toBe(0);
    expect(window.max).toBe(2 * HOUR);
  });

  it("respects the minimum span", () => {
    let window: TimeWindow | undefined;
    for (let i = 0; i < 50; i += 1) {
      window = zoomTimeWindow(full, window, 0.5, 0.5);
    }
    expect(window!.max - window!.min).toBeGreaterThanOrEqual(30_000);
  });

  it("ignores degenerate ranges and factors", () => {
    expect(zoomTimeWindow({ min: 5, max: 5 }, undefined, 0.5, 0.5)).toBeUndefined();
    const current: TimeWindow = { min: HOUR, max: 2 * HOUR };
    expect(zoomTimeWindow(full, current, 0.5, Number.NaN)).toBe(current);
  });
});

describe("panTimeWindow", () => {
  it("shifts the window by a fraction of its span", () => {
    const current: TimeWindow = { min: 2 * HOUR, max: 4 * HOUR };
    expect(panTimeWindow(full, current, 0.5)).toEqual({ min: 3 * HOUR, max: 5 * HOUR });
    expect(panTimeWindow(full, current, -0.5)).toEqual({ min: HOUR, max: 3 * HOUR });
  });

  it("clamps at the edges of the full range", () => {
    const current: TimeWindow = { min: 8 * HOUR, max: 10 * HOUR };
    expect(panTimeWindow(full, current, 5)).toBe(current);
    expect(panTimeWindow(full, { min: HOUR, max: 3 * HOUR }, -10)).toEqual({ min: 0, max: 2 * HOUR });
  });

  it("does nothing for a full view", () => {
    expect(panTimeWindow(full, undefined, 0.5)).toBeUndefined();
  });
});
