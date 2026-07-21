import { useEffect, useState } from "react";
import type { GpuDailyStat, GpuIdentity, GpuMetric, GpuProcess, GpuSighting } from "../shared/types";
import { copyText } from "./clipboard";
import { formatNullable, formatTime } from "./formatters";
import { shortUuid } from "./gpuFormat";
import { chartColors, LineChart } from "./LineChart";
import { buildDailySeries, buildMetricFieldSeries } from "./powerChartData";
import { useTimeWindow } from "./useTimeWindow";

type GpuDetail = {
  gpu: GpuIdentity;
  sightings: GpuSighting[];
  metrics: GpuMetric[];
  processes: GpuProcess[];
  dailyStats: GpuDailyStat[];
};

export function GpuDetailModal({ uuid, onClose, onOpenMachine }: {
  uuid: string;
  onClose: () => void;
  onOpenMachine?: (machineId: number) => void;
}) {
  const [detail, setDetail] = useState<GpuDetail | undefined>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setError("");
    fetch(`/api/gpus/${encodeURIComponent(uuid)}?hours=24`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("GPU not found"))))
      .then((next: GpuDetail) => {
        if (!cancelled) {
          setDetail(next);
        }
      })
      .catch((fetchError: Error) => {
        if (!cancelled) {
          setError(fetchError.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [uuid]);

  const copyUuid = async () => {
    await copyText(uuid);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={`GPU ${uuid} details`} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>GPU {shortUuid(uuid)}</h2>
          {detail?.gpu.gpuType ? <span className="chip">{detail.gpu.gpuType}</span> : null}
          <button className="ip-copy" title="Copy full UUID" onClick={() => void copyUuid()}>{uuid}</button>
          {copied ? <span className="chip copied">copied</span> : null}
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {error ? <p className="empty-chart">{error}</p> : null}
        {!detail && !error ? <p className="empty-chart">Loading GPU history…</p> : null}
        {detail ? <GpuDetailPane detail={detail} onOpenMachine={onOpenMachine} /> : null}
      </div>
    </div>
  );
}

function GpuDetailPane({ detail, onOpenMachine }: { detail: GpuDetail; onOpenMachine?: (machineId: number) => void }) {
  const { gpu, sightings, metrics, processes, dailyStats } = detail;
  const current = sightings[0];

  return (
    <aside className="detail-panel">
      <dl className="metadata">
        <div><dt>Type</dt><dd>{gpu.gpuType || "-"}</dd></div>
        <div><dt>Machine</dt><dd>{gpu.lastMachineName || "-"}{gpu.lastGpuIndex !== null ? ` · slot ${gpu.lastGpuIndex}` : ""}</dd></div>
        <div><dt>Owner</dt><dd>{gpu.lastOwner || "-"}</dd></div>
        <div><dt>Placements</dt><dd>{gpu.sightingCount ?? sightings.length}</dd></div>
        <div><dt>First seen</dt><dd>{formatTime(gpu.firstSeenAt)}</dd></div>
        <div><dt>Last seen</dt><dd>{formatTime(gpu.lastSeenAt)}</dd></div>
        <div><dt>In place since</dt><dd>{current ? formatTime(current.firstSeenAt) : "-"}</dd></div>
        <div><dt>PCIe</dt><dd className="mono">{metrics[0]?.pciBusId || "-"}</dd></div>
      </dl>

      <details className="detail-section" open>
        <summary>GPU history (24h)</summary>
        <GpuMetricCharts metrics={metrics} />
      </details>

      <details className="detail-section" open>
        <summary>Placement history</summary>
        <div className="history-list">
          {sightings.length === 0 ? <p>No placements recorded yet.</p> : null}
          {sightings.map((sighting, index) => (
            <div className="sighting-row" key={sighting.id ?? `${sighting.machineId}-${sighting.firstSeenAt}`}>
              <span className={`chip ${index === 0 ? "current" : ""}`}>{index === 0 ? "current" : "past"}</span>
              {onOpenMachine ? (
                <button className="link-button" onClick={() => onOpenMachine(sighting.machineId)}>
                  {sighting.machineName || `machine ${sighting.machineId}`}
                </button>
              ) : <span>{sighting.machineName || `machine ${sighting.machineId}`}</span>}
              <span>slot {sighting.gpuIndex}</span>
              <span>{sighting.owner || "unassigned"}</span>
              <span className="time-cell">{formatTime(sighting.firstSeenAt)} → {formatTime(sighting.lastSeenAt)}</span>
            </div>
          ))}
        </div>
      </details>

      <details className="detail-section">
        <summary>Daily rollups</summary>
        <GpuDailyCharts dailyStats={dailyStats} />
      </details>

      <details className="detail-section">
        <summary>Job history</summary>
        <div className="process-list">
          {processes.length === 0 ? <p>No GPU jobs recorded for this card yet.</p> : null}
          {processes.map((process) => (
            <div className="gpu-job-row" key={`${process.id}-${process.pid}`}>
              <span className="time-cell">{formatTime(process.checkedAt)}</span>
              <span>{process.machineName || "-"}</span>
              <span>{process.owner || "-"}</span>
              <span className="pid">PID {process.pid}</span>
              <span className="command">{process.commandLine || process.command || "-"}</span>
            </div>
          ))}
        </div>
      </details>
    </aside>
  );
}

function GpuMetricCharts({ metrics }: { metrics: GpuMetric[] }) {
  const timestamps = metrics.map((metric) => Date.parse(metric.checkedAt ?? "")).filter(Number.isFinite);
  const fullRange = timestamps.length > 0 ? { min: Math.min(...timestamps), max: Math.max(...timestamps) } : undefined;
  const { view, zoomAt, panBy, reset } = useTimeWindow(fullRange);
  const chartProps = { view, fullRange, onZoom: zoomAt, onPan: panBy, onReset: reset };

  return (
    <div className="power-charts">
      <div className="chart-toolbar">
        <span className="chart-hint">Pinch or ⌃scroll to zoom · drag to pan · double-click to reset</span>
        {view ? <button className="chart-reset" onClick={reset}>Reset zoom</button> : null}
      </div>
      <LineChart
        ariaLabel="GPU utilization over time"
        emptyText="No utilization history recorded for this GPU yet."
        lines={[
          { label: "GPU util", color: chartColors[0], points: buildMetricFieldSeries(metrics, (metric) => metric.gpuUtil) },
          { label: "Mem util", color: chartColors[1], points: buildMetricFieldSeries(metrics, (metric) => metric.memUtil) },
        ]}
        unit="%"
        yMax={100}
        {...chartProps}
      />
      <LineChart
        ariaLabel="GPU temperature over time"
        emptyText="No temperature history recorded for this GPU yet."
        lines={[{ label: "Temp", color: chartColors[2], points: buildMetricFieldSeries(metrics, (metric) => metric.tempC) }]}
        unit="°C"
        {...chartProps}
      />
      <LineChart
        ariaLabel="GPU power draw over time"
        emptyText="No power history recorded for this GPU yet."
        lines={[{ label: "Power", color: chartColors[3], points: buildMetricFieldSeries(metrics, (metric) => metric.powerW) }]}
        unit="W"
        {...chartProps}
      />
    </div>
  );
}

function GpuDailyCharts({ dailyStats }: { dailyStats: GpuDailyStat[] }) {
  const timestamps = dailyStats.map((entry) => Date.parse(`${entry.day}T00:00:00Z`)).filter(Number.isFinite);
  const fullRange = timestamps.length > 0 ? { min: Math.min(...timestamps), max: Math.max(...timestamps) } : undefined;
  const { view, zoomAt, panBy, reset } = useTimeWindow(fullRange);
  const chartProps = { view, fullRange, onZoom: zoomAt, onPan: panBy, onReset: reset };

  return (
    <div className="power-charts">
      <p className="chart-hint">
        Daily aggregates survive history pruning, so they cover this card's whole life.
        {dailyStats.length === 0 ? " The first row appears after the current UTC day completes." : ""}
      </p>
      <LineChart
        ariaLabel="Daily average and peak GPU utilization"
        emptyText="No daily rollups recorded for this GPU yet."
        lines={[
          { label: "Avg util", color: chartColors[0], points: buildDailySeries(dailyStats, (entry) => entry.avgGpuUtil) },
          { label: "Peak util", color: chartColors[1], points: buildDailySeries(dailyStats, (entry) => entry.maxGpuUtil) },
        ]}
        unit="%"
        yMax={100}
        {...chartProps}
      />
      <LineChart
        ariaLabel="Daily average and peak GPU temperature"
        emptyText="No daily rollups recorded for this GPU yet."
        lines={[
          { label: "Avg temp", color: chartColors[2], points: buildDailySeries(dailyStats, (entry) => entry.avgTempC) },
          { label: "Peak temp", color: chartColors[3], points: buildDailySeries(dailyStats, (entry) => entry.maxTempC) },
        ]}
        unit="°C"
        {...chartProps}
      />
      {dailyStats.length > 0 ? (
        <p className="chart-hint">
          {dailyStats.length} day{dailyStats.length === 1 ? "" : "s"} rolled up ·
          {" "}latest {dailyStats[0].day}: {formatNullable(dailyStats[0].avgGpuUtil, "%")} avg util,
          {" "}{formatNullable(dailyStats[0].avgPowerW, " W")} avg power over {dailyStats[0].sampleCount} samples
        </p>
      ) : null}
    </div>
  );
}
