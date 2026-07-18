import { useRef, useState } from "react";
import type { ProbeResult } from "../shared/types";
import { buildPowerChartSeries, type PowerChartPoint } from "./powerChartData";

/* Validated categorical palette slots, fixed order (see styles.css tokens). */
const chartColors = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
];

type ChartLineData = { label: string; color: string; points: PowerChartPoint[] };

export function PowerCharts({ history }: { history: ProbeResult[] }) {
  const series = buildPowerChartSeries(history);
  return (
    <div className="power-charts">
      <PowerLineChart
        ariaLabel="Total GPU power consumption over time"
        emptyText="No total GPU power history recorded."
        lines={[{ label: "Total", color: chartColors[0], points: series.total }]}
        timeRange={series.timeRange}
      />
      <PowerLineChart
        ariaLabel="Per GPU power consumption over time"
        emptyText="No per-GPU power history recorded."
        lines={series.perGpu.map((gpu, index) => ({
          label: `GPU ${gpu.gpuIndex}`,
          color: chartColors[index % chartColors.length],
          points: gpu.points,
        }))}
        timeRange={series.timeRange}
      />
    </div>
  );
}

const width = 760;
const height = 220;
const pad = { top: 16, right: 18, bottom: 34, left: 48 };
const plotWidth = width - pad.left - pad.right;
const plotHeight = height - pad.top - pad.bottom;

function PowerLineChart({
  ariaLabel,
  emptyText,
  lines,
  timeRange,
}: {
  ariaLabel: string;
  emptyText: string;
  lines: ChartLineData[];
  timeRange?: { min: number; max: number };
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverTime, setHoverTime] = useState<number | undefined>();
  const drawableLines = lines.filter((line) => line.points.length > 0);
  const timestamps = [...new Set(drawableLines.flatMap((line) => line.points.map((point) => point.timestamp)))].sort((a, b) => a - b);

  if (drawableLines.length === 0) {
    return <p className="empty-chart">{emptyText}</p>;
  }

  const allPoints = drawableLines.flatMap((line) => line.points);
  const minTime = timeRange?.min ?? Math.min(...allPoints.map((point) => point.timestamp));
  const maxTime = timeRange?.max ?? Math.max(...allPoints.map((point) => point.timestamp));
  const maxWatts = Math.max(1, ...allPoints.map((point) => point.value));
  const toX = (timestamp: number) => {
    if (minTime === maxTime) {
      return pad.left + plotWidth / 2;
    }
    return pad.left + ((timestamp - minTime) / (maxTime - minTime)) * plotWidth;
  };
  const toY = (value: number) => pad.top + plotHeight - (value / maxWatts) * plotHeight;

  const onMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || timestamps.length === 0) {
      return;
    }
    const rect = svg.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * width;
    const cursorTime = minTime === maxTime
      ? minTime
      : minTime + ((viewX - pad.left) / plotWidth) * (maxTime - minTime);
    let nearest = timestamps[0];
    for (const timestamp of timestamps) {
      if (Math.abs(timestamp - cursorTime) < Math.abs(nearest - cursorTime)) {
        nearest = timestamp;
      }
    }
    setHoverTime(nearest);
  };

  const hoverX = hoverTime === undefined ? undefined : toX(hoverTime);
  const hoverRows = hoverTime === undefined ? [] : drawableLines.flatMap((line) => {
    const point = line.points.find((candidate) => candidate.timestamp === hoverTime);
    return point ? [{ label: line.label, color: line.color, point }] : [];
  });
  const tooltipOnLeft = hoverX !== undefined && hoverX > width * 0.62;

  return (
    <div className="power-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoverTime(undefined)}
      >
        <line className="chart-axis" x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotHeight} />
        <line className="chart-axis" x1={pad.left} y1={pad.top + plotHeight} x2={pad.left + plotWidth} y2={pad.top + plotHeight} />
        {[0.25, 0.5, 0.75, 1].map((fraction) => {
          const y = pad.top + plotHeight - fraction * plotHeight;
          return (
            <g key={fraction}>
              <line className="chart-grid" x1={pad.left} y1={y} x2={pad.left + plotWidth} y2={y} />
              <text className="chart-label" x={pad.left - 8} y={y + 4} textAnchor="end">{Math.round(maxWatts * fraction)}</text>
            </g>
          );
        })}
        <text className="chart-label" x={pad.left - 8} y={pad.top + plotHeight + 4} textAnchor="end">0</text>
        <text className="chart-label" x={pad.left} y={height - 10}>{new Date(minTime).toLocaleTimeString()}</text>
        <text className="chart-label" x={pad.left + plotWidth} y={height - 10} textAnchor="end">{new Date(maxTime).toLocaleTimeString()}</text>
        {drawableLines.map((line) => (
          <g key={line.label}>
            <path
              className="chart-line"
              d={toPath(line.points, toX, toY)}
              fill="none"
              style={{ stroke: line.color }}
            />
          </g>
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
              <strong>{formatWattValue(row.point.value)} W</strong>
            </div>
          ))}
        </div>
      ) : null}
      {drawableLines.length > 1 ? (
        <div className="chart-legend">
          {drawableLines.map((line) => (
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

function formatWattValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function toPath(
  points: PowerChartPoint[],
  toX: (timestamp: number) => number,
  toY: (value: number) => number,
): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${toX(point.timestamp).toFixed(2)} ${toY(point.value).toFixed(2)}`).join(" ");
}
