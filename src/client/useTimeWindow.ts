import { useCallback, useState } from "react";
import { panTimeWindow, zoomTimeWindow, type TimeWindow } from "./timeWindow";

export function useTimeWindow(fullRange?: TimeWindow) {
  const [view, setView] = useState<TimeWindow | undefined>();
  const fullMin = fullRange?.min;
  const fullMax = fullRange?.max;

  const zoomAt = useCallback((anchorFraction: number, factor: number) => {
    if (fullMin === undefined || fullMax === undefined) {
      return;
    }
    setView((current) => zoomTimeWindow({ min: fullMin, max: fullMax }, current, anchorFraction, factor));
  }, [fullMin, fullMax]);

  const panBy = useCallback((deltaFraction: number) => {
    if (fullMin === undefined || fullMax === undefined) {
      return;
    }
    setView((current) => panTimeWindow({ min: fullMin, max: fullMax }, current, deltaFraction));
  }, [fullMin, fullMax]);

  const reset = useCallback(() => setView(undefined), []);

  return { view, zoomAt, panBy, reset };
}
