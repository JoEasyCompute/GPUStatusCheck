import { useEffect, useState } from "react";
import type { GroupHistoryPoint } from "../shared/types";
import { chartColors, LineChart } from "./LineChart";
import type { PowerChartPoint } from "./powerChartData";
import { useTimeWindow } from "./useTimeWindow";

export function GroupCharts({ groupBy, label }: { groupBy: "owner" | "location"; label: string }) {
  const [points, setPoints] = useState<GroupHistoryPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/group-history?by=${groupBy}&key=${encodeURIComponent(label)}&hours=24`)
        .then((response) => response.json())
        .then((next: GroupHistoryPoint[]) => {
          if (!cancelled && Array.isArray(next)) {
            setPoints(next);
          }
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [groupBy, label]);

  const powerLine = toLine(points, (point) => point.totalPowerW);
  const tempLine = toLine(points, (point) => point.averageTempC);
  const utilLine = toLine(points, (point) => point.averageGpuUtil);
  const rxLine = toLine(points, (point) => toMbps(point.netRxBps));
  const txLine = toLine(points, (point) => toMbps(point.netTxBps));
  const timestamps = points.map((point) => Date.parse(point.startedAt)).filter(Number.isFinite);
  const fullRange = timestamps.length > 0 ? { min: Math.min(...timestamps), max: Math.max(...timestamps) } : undefined;
  const { view, zoomAt, panBy, reset } = useTimeWindow(fullRange);
  const chartProps = {
    view,
    fullRange,
    onZoom: zoomAt,
    onPan: panBy,
    onReset: reset,
  };
  const name = label || "Unassigned";

  return (
    <div className="group-charts" onClick={(event) => event.stopPropagation()}>
      <div className="chart-toolbar">
        <span className="chart-hint">Group history (24h) · pinch or ^scroll to zoom · drag to pan · double-click to reset</span>
        {view ? <button className="chart-reset" onClick={reset}>Reset zoom</button> : null}
      </div>
      <div className="power-charts group-charts-grid">
        <LineChart
          ariaLabel={`Total GPU power for ${name} over time`}
          emptyText="No power history recorded for this group yet."
          lines={[{ label: "Total power", color: chartColors[0], points: powerLine }]}
          unit="W"
          {...chartProps}
        />
        <LineChart
          ariaLabel={`Average GPU temperature for ${name} over time`}
          emptyText="No temperature history recorded for this group yet."
          lines={[{ label: "Avg temp", color: chartColors[1], points: tempLine }]}
          unit="°C"
          {...chartProps}
        />
        <LineChart
          ariaLabel={`Average GPU utilization for ${name} over time`}
          emptyText="No utilization history recorded for this group yet."
          lines={[{ label: "Avg GPU util", color: chartColors[2], points: utilLine }]}
          unit="%"
          yMax={100}
          {...chartProps}
        />
        <LineChart
          ariaLabel={`Total network traffic for ${name} over time`}
          emptyText="No network history recorded for this group yet."
          lines={[
            { label: "↓ In", color: chartColors[3], points: rxLine },
            { label: "↑ Out", color: chartColors[4], points: txLine },
          ]}
          unit="Mbps"
          {...chartProps}
        />
      </div>
    </div>
  );
}

function toMbps(bps: number | null): number | null {
  return bps === null || bps === undefined ? null : Number(((bps * 8) / 1_000_000).toFixed(2));
}

function toLine(points: GroupHistoryPoint[], pick: (point: GroupHistoryPoint) => number | null): PowerChartPoint[] {
  const line: PowerChartPoint[] = [];
  for (const point of points) {
    const timestamp = Date.parse(point.startedAt);
    const value = pick(point);
    if (!Number.isFinite(timestamp) || value === null || !Number.isFinite(value)) {
      continue;
    }
    line.push({ timestamp, label: point.startedAt, value });
  }
  return line;
}
