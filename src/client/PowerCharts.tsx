import { useState } from "react";
import type { ProbeResult } from "../shared/types";
import { chartColors, LineChart } from "./LineChart";
import { buildGpuMetricSeries, buildNetworkChartSeries, buildPowerChartSeries, buildProbeFieldSeries } from "./powerChartData";
import { useTimeWindow } from "./useTimeWindow";

type MetricTab = "power" | "temp" | "util" | "network" | "system";

const tabs: Array<{ id: MetricTab; label: string }> = [
  { id: "power", label: "Power" },
  { id: "temp", label: "Temperature" },
  { id: "util", label: "Utilization" },
  { id: "network", label: "Network" },
  { id: "system", label: "System" },
];

export function GpuCharts({ history }: { history: ProbeResult[] }) {
  const [tab, setTab] = useState<MetricTab>("power");
  const powerSeries = buildPowerChartSeries(history);
  const { view, zoomAt, panBy, reset } = useTimeWindow(powerSeries.timeRange);
  const chartProps = {
    view,
    fullRange: powerSeries.timeRange,
    onZoom: zoomAt,
    onPan: panBy,
    onReset: reset,
  };

  return (
    <div className="power-charts">
      <div className="chart-toolbar">
        <div className="chart-tabs" role="tablist">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`chart-tab ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="chart-hint">Pinch or ⌃scroll to zoom · drag to pan · double-click to reset</span>
        {view ? <button className="chart-reset" onClick={reset}>Reset zoom</button> : null}
      </div>

      {tab === "power" ? (
        <>
          <LineChart
            ariaLabel="Total GPU power consumption over time"
            emptyText="No total GPU power history recorded."
            lines={[{ label: "Total", color: chartColors[0], points: powerSeries.total }]}
            unit="W"
            {...chartProps}
          />
          <LineChart
            ariaLabel="Per GPU power consumption over time"
            emptyText="No per-GPU power history recorded."
            lines={powerSeries.perGpu.map((gpu, index) => ({
              label: `GPU ${gpu.gpuIndex}`,
              color: chartColors[index % chartColors.length],
              points: gpu.points,
            }))}
            unit="W"
            {...chartProps}
          />
        </>
      ) : null}

      {tab === "temp" ? (
        <LineChart
          ariaLabel="Per GPU temperature over time"
          emptyText="No GPU temperature history recorded."
          lines={buildGpuMetricSeries(history, (metric) => metric.tempC).perGpu.map((gpu, index) => ({
            label: `GPU ${gpu.gpuIndex}`,
            color: chartColors[index % chartColors.length],
            points: gpu.points,
          }))}
          unit="°C"
          {...chartProps}
        />
      ) : null}

      {tab === "network" ? (
        <NetworkChart history={history} chartProps={chartProps} />
      ) : null}

      {tab === "system" ? (
        <LineChart
          ariaLabel="CPU, RAM, and disk utilization over time"
          emptyText="No system utilization history recorded yet."
          lines={[
            { label: "CPU", color: chartColors[0], points: buildProbeFieldSeries(history, (entry) => entry.cpuUtilPct) },
            { label: "RAM", color: chartColors[1], points: buildProbeFieldSeries(history, (entry) => entry.memUsedPct) },
            { label: "Disk", color: chartColors[2], points: buildProbeFieldSeries(history, (entry) => entry.diskUsedPct) },
          ]}
          unit="%"
          yMax={100}
          {...chartProps}
        />
      ) : null}

      {tab === "util" ? (
        <LineChart
          ariaLabel="Per GPU utilization over time"
          emptyText="No GPU utilization history recorded."
          lines={buildGpuMetricSeries(history, (metric) => metric.gpuUtil).perGpu.map((gpu, index) => ({
            label: `GPU ${gpu.gpuIndex}`,
            color: chartColors[index % chartColors.length],
            points: gpu.points,
          }))}
          unit="%"
          yMax={100}
          {...chartProps}
        />
      ) : null}
    </div>
  );
}

function NetworkChart({
  history,
  chartProps,
}: {
  history: ProbeResult[];
  chartProps: Omit<Parameters<typeof LineChart>[0], "ariaLabel" | "emptyText" | "lines" | "unit">;
}) {
  const series = buildNetworkChartSeries(history);
  return (
    <LineChart
      ariaLabel="Network traffic in and out over time"
      emptyText="No network traffic history recorded yet."
      lines={[
        { label: "In", color: chartColors[0], points: series.rx },
        { label: "Out", color: chartColors[1], points: series.tx },
      ]}
      unit="Mbps"
      {...chartProps}
    />
  );
}
