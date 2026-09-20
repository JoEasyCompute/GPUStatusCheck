import { useEffect, useState } from "react";
import type { FleetHistoryPoint } from "../shared/types";
import { fetchJsonArray } from "./api";
import { chartColors, LineChart } from "./LineChart";
import type { PowerChartPoint } from "./powerChartData";
import { useTimeWindow } from "./useTimeWindow";

export function FleetCharts() {
  const [points, setPoints] = useState<FleetHistoryPoint[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchJsonArray<FleetHistoryPoint>("/api/fleet-history?hours=24")
        .then((next) => {
          if (!cancelled) {
            setPoints(next);
            setError("");
          }
        })
        .catch((loadError) => {
          if (!cancelled) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
          }
        });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const powerLine = toLine(points, (point) => point.totalPowerW);
  const okLine = toLine(points, (point) => point.okCount);
  const degradedLine = toLine(points, (point) => point.degradedCount);
  const failedLine = toLine(points, (point) => point.sshFailedCount);
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

  return (
    <details className="panel fleet-panel">
      <summary>
        <h2>Fleet history (24h)</h2>
        {view ? (
          <button
            className="chart-reset"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              reset();
            }}
          >
            Reset zoom
          </button>
        ) : null}
      </summary>
      {error ? <p className="load-error">Fleet history unavailable: {error}</p> : null}
      <div className="power-charts">
        <LineChart
          ariaLabel="Total fleet GPU power consumption over time"
          emptyText="No fleet power history recorded yet."
          lines={[{ label: "Fleet power", color: chartColors[0], points: powerLine }]}
          unit="W"
          {...chartProps}
        />
        <LineChart
          ariaLabel="Machine status counts over time"
          emptyText="No fleet status history recorded yet."
          lines={[
            { label: "OK", color: "var(--good)", points: okLine },
            { label: "Degraded", color: "var(--warn)", points: degradedLine },
            { label: "SSH failed", color: "var(--crit)", points: failedLine },
          ]}
          unit=""
          {...chartProps}
        />
      </div>
    </details>
  );
}

function toLine(points: FleetHistoryPoint[], pick: (point: FleetHistoryPoint) => number | null): PowerChartPoint[] {
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
