import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PowerChartPoint } from "./powerChartData";
import type { TimeWindow } from "./timeWindow";

/* Validated categorical palette slots, fixed order (see styles.css tokens). */
export const chartColors = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
];

export type ChartLineData = { label: string; color: string; points: PowerChartPoint[] };

const width = 760;
const height = 220;
const pad = { top: 16, right: 18, bottom: 34, left: 48 };
const plotWidth = width - pad.left - pad.right;
const plotHeight = height - pad.top - pad.bottom;

export function LineChart({
  ariaLabel,
  emptyText,
  lines,
  view,
  fullRange,
  onZoom,
  onPan,
  onReset,
  unit,
  yMax,
}: {
  ariaLabel: string;
  emptyText: string;
  lines: ChartLineData[];
  view?: TimeWindow;
  fullRange?: TimeWindow;
  onZoom: (anchorFraction: number, factor: number) => void;
  onPan: (deltaFraction: number) => void;
  onReset: () => void;
  unit: string;
  yMax?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({ dragging: false, moved: false });
  const [hoverTime, setHoverTime] = useState<number | undefined>();
  const [grabbing, setGrabbing] = useState(false);
  const rawClipId = useId();
  const clipId = `plot-clip-${rawClipId.replace(/[^a-zA-Z0-9-]/g, "")}`;

  const drawableLines = lines.filter((line) => line.points.length > 0);
  const allPoints = drawableLines.flatMap((line) => line.points);
  const minTime = view?.min ?? fullRange?.min ?? (allPoints.length > 0 ? Math.min(...allPoints.map((point) => point.timestamp)) : 0);
  const maxTime = view?.max ?? fullRange?.max ?? (allPoints.length > 0 ? Math.max(...allPoints.map((point) => point.timestamp)) : 0);

  const visibleLines = drawableLines
    .map((line) => ({ ...line, points: visibleSegment(line.points, minTime, maxTime) }))
    .filter((line) => line.points.length > 0);
  const inWindowPoints = visibleLines.flatMap((line) => line.points.filter((point) => point.timestamp >= minTime && point.timestamp <= maxTime));
  const scalePoints = inWindowPoints.length > 0 ? inWindowPoints : visibleLines.flatMap((line) => line.points);
  const maxValue = yMax ?? Math.max(1, ...scalePoints.map((point) => point.value));
  const timestamps = [...new Set(inWindowPoints.map((point) => point.timestamp))].sort((a, b) => a - b);

  const toX = useCallback((timestamp: number) => {
    if (minTime === maxTime) {
      return pad.left + plotWidth / 2;
    }
    return pad.left + ((timestamp - minTime) / (maxTime - minTime)) * plotWidth;
  }, [minTime, maxTime]);
  const toY = (value: number) => pad.top + plotHeight - (value / maxValue) * plotHeight;

  const clientToFraction = useCallback((clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) {
      return 0.5;
    }
    const rect = svg.getBoundingClientRect();
    const viewX = ((clientX - rect.left) / rect.width) * width;
    return Math.min(1, Math.max(0, (viewX - pad.left) / plotWidth));
  }, []);

  const clientDxToFraction = useCallback((dxClient: number): number => {
    const svg = svgRef.current;
    if (!svg || svg.getBoundingClientRect().width === 0) {
      return 0;
    }
    return (dxClient * (width / svg.getBoundingClientRect().width)) / plotWidth;
  }, []);

  // Native wheel listener: React's synthetic handler cannot reliably
  // preventDefault, and macOS trackpad pinch arrives as ctrl+wheel.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        onZoom(clientToFraction(event.clientX), Math.exp(event.deltaY * 0.005));
        return;
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        onPan(clientDxToFraction(event.deltaX));
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [onZoom, onPan, clientToFraction, clientDxToFraction]);

  if (drawableLines.length === 0) {
    return <p className="empty-chart">{emptyText}</p>;
  }

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gestureRef.current = { dragging: true, moved: false };
    setHoverTime(undefined);
    setGrabbing(true);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) {
      if (event.pointerType === "mouse") {
        updateHover(event.clientX);
      }
      return;
    }
    const previous = pointers.get(event.pointerId)!;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);

    if (pointers.size === 1) {
      const dx = next.x - previous.x;
      if (dx !== 0) {
        gestureRef.current.moved = true;
        onPan(-clientDxToFraction(dx));
      }
      return;
    }

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const previousOther = a === next ? b : a;
      const previousDist = Math.max(12, Math.hypot(previous.x - previousOther.x, previous.y - previousOther.y));
      const nextDist = Math.max(12, Math.hypot(next.x - previousOther.x, next.y - previousOther.y));
      const midX = (next.x + previousOther.x) / 2;
      gestureRef.current.moved = true;
      onZoom(clientToFraction(midX), previousDist / nextDist);
      const midDx = (next.x - previous.x) / 2;
      if (midDx !== 0) {
        onPan(-clientDxToFraction(midDx));
      }
    }
  };

  const onPointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) {
      gestureRef.current.dragging = false;
      setGrabbing(false);
    }
  };

  const updateHover = (clientX: number) => {
    if (gestureRef.current.dragging || timestamps.length === 0) {
      return;
    }
    const fraction = clientToFraction(clientX);
    const cursorTime = minTime === maxTime ? minTime : minTime + fraction * (maxTime - minTime);
    let nearest = timestamps[0];
    for (const timestamp of timestamps) {
      if (Math.abs(timestamp - cursorTime) < Math.abs(nearest - cursorTime)) {
        nearest = timestamp;
      }
    }
    setHoverTime(nearest);
  };

  const hoverX = hoverTime === undefined ? undefined : toX(hoverTime);
  const hoverRows = hoverTime === undefined ? [] : visibleLines.flatMap((line) => {
    const point = line.points.find((candidate) => candidate.timestamp === hoverTime);
    return point ? [{ label: line.label, color: line.color, point }] : [];
  });
  const tooltipOnLeft = hoverX !== undefined && hoverX > width * 0.62;

  return (
    <div className={`power-chart ${grabbing ? "grabbing" : ""}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={(event) => updateHover(event.clientX)}
        onMouseLeave={() => setHoverTime(undefined)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={onReset}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.left} y={pad.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>
        <line className="chart-axis" x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotHeight} />
        <line className="chart-axis" x1={pad.left} y1={pad.top + plotHeight} x2={pad.left + plotWidth} y2={pad.top + plotHeight} />
        {[0.25, 0.5, 0.75, 1].map((fraction) => {
          const y = pad.top + plotHeight - fraction * plotHeight;
          return (
            <g key={fraction}>
              <line className="chart-grid" x1={pad.left} y1={y} x2={pad.left + plotWidth} y2={y} />
              <text className="chart-label" x={pad.left - 8} y={y + 4} textAnchor="end">{formatAxisValue(maxValue * fraction)}</text>
            </g>
          );
        })}
        <text className="chart-label" x={pad.left - 8} y={pad.top + plotHeight + 4} textAnchor="end">0</text>
        <text className="chart-label" x={pad.left} y={height - 10}>{new Date(minTime).toLocaleTimeString()}</text>
        <text className="chart-label" x={pad.left + plotWidth} y={height - 10} textAnchor="end">{new Date(maxTime).toLocaleTimeString()}</text>
        <g clipPath={`url(#${clipId})`}>
          {visibleLines.map((line) => (
            <path
              key={line.label}
              className="chart-line"
              d={toPath(line.points, toX, toY)}
              fill="none"
              style={{ stroke: line.color }}
            />
          ))}
          {hoverX !== undefined ? (
            <g>
              <line className="chart-crosshair" x1={hoverX} y1={pad.top} x2={hoverX} y2={pad.top + plotHeight} />
              {hoverRows.map((row) => (
                <circle
                  key={row.label}
                  className="chart-hover-dot"
                  cx={toX(row.point.timestamp)}
                  cy={toY(row.point.value)}
                  r={4}
                  style={{ fill: row.color }}
                />
              ))}
            </g>
          ) : null}
        </g>
      </svg>
      {hoverTime !== undefined && hoverRows.length > 0 ? (
        <div
          className="chart-tooltip"
          style={{
            left: `${((hoverX ?? 0) / width) * 100}%`,
            transform: tooltipOnLeft ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
          }}
        >
          <time>{new Date(hoverTime).toLocaleTimeString()}</time>
          {hoverRows.map((row) => (
            <div className="chart-tooltip-row" key={row.label}>
              <i style={{ backgroundColor: row.color }} />
              <span>{row.label}</span>
              <strong>{formatValue(row.point.value)}{unit ? ` ${unit}` : ""}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {visibleLines.length > 1 ? (
        <div className="chart-legend">
          {visibleLines.map((line) => (
            <span key={line.label}>
              <i style={{ backgroundColor: line.color }} />
              {line.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Points inside [min, max] plus one neighbor on each side for line continuity. */
function visibleSegment(points: PowerChartPoint[], min: number, max: number): PowerChartPoint[] {
  if (points.length === 0) {
    return points;
  }
  const firstInside = points.findIndex((point) => point.timestamp >= min);
  const firstBeyond = points.findIndex((point) => point.timestamp > max);
  const start = Math.max(0, (firstInside === -1 ? points.length : firstInside) - 1);
  const end = Math.min(points.length, (firstBeyond === -1 ? points.length : firstBeyond) + 1);
  return points.slice(start, end);
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatAxisValue(value: number): string {
  if (value > 0 && value < 10) {
    return value.toFixed(1);
  }
  return String(Math.round(value));
}

function toPath(
  points: PowerChartPoint[],
  toX: (timestamp: number) => number,
  toY: (value: number) => number,
): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${toX(point.timestamp).toFixed(2)} ${toY(point.value).toFixed(2)}`).join(" ");
}
