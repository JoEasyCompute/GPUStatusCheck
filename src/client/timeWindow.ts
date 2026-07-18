export type TimeWindow = { min: number; max: number };

const MIN_SPAN_MS = 30_000;

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Zoom the visible window by `factor` (< 1 zooms in), keeping the time at
 * `anchorFraction` (0..1 across the current window) fixed under the cursor.
 * Returns undefined when the result covers the full range.
 */
export function zoomTimeWindow(
  full: TimeWindow,
  current: TimeWindow | undefined,
  anchorFraction: number,
  factor: number,
): TimeWindow | undefined {
  const fullSpan = full.max - full.min;
  if (fullSpan <= 0 || !Number.isFinite(factor) || factor <= 0) {
    return current;
  }
  const base = current ?? full;
  const span = base.max - base.min;
  const minSpan = Math.min(fullSpan, Math.max(MIN_SPAN_MS, fullSpan / 200));
  const nextSpan = Math.min(fullSpan, Math.max(minSpan, span * factor));
  const fraction = clampFraction(anchorFraction);
  const anchor = base.min + fraction * span;
  let min = anchor - fraction * nextSpan;
  let max = min + nextSpan;
  if (min < full.min) {
    min = full.min;
    max = min + nextSpan;
  }
  if (max > full.max) {
    max = full.max;
    min = max - nextSpan;
  }
  if (min <= full.min && max >= full.max) {
    return undefined;
  }
  return { min, max };
}

/**
 * Shift the visible window by `deltaFraction` of its own span, clamped to the
 * full range. A full (undefined) view has nowhere to pan.
 */
export function panTimeWindow(
  full: TimeWindow,
  current: TimeWindow | undefined,
  deltaFraction: number,
): TimeWindow | undefined {
  if (!current || !Number.isFinite(deltaFraction)) {
    return current;
  }
  const span = current.max - current.min;
  const shift = Math.min(full.max - current.max, Math.max(full.min - current.min, deltaFraction * span));
  if (shift === 0) {
    return current;
  }
  return { min: current.min + shift, max: current.max + shift };
}
