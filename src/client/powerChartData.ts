import type { GpuMetric, ProbeResult } from "../shared/types";

export type PowerChartPoint = {
  timestamp: number;
  label: string;
  value: number;
};

export type GpuPowerSeries = {
  gpuIndex: number;
  points: PowerChartPoint[];
};

export type PowerChartSeries = {
  total: PowerChartPoint[];
  perGpu: GpuPowerSeries[];
  maxWatts: number;
  timeRange?: {
    min: number;
    max: number;
  };
};

export function buildPowerChartSeries(history: ProbeResult[]): PowerChartSeries {
  const total: PowerChartPoint[] = [];
  const gpuPoints = new Map<number, PowerChartPoint[]>();
  let maxWatts = 0;
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;

  const chronologicalHistory = [...history].sort((a, b) => parseTime(a.checkedAt) - parseTime(b.checkedAt));
  for (const entry of chronologicalHistory) {
    const timestamp = parseTime(entry.checkedAt);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    minTime = Math.min(minTime, timestamp);
    maxTime = Math.max(maxTime, timestamp);
    const label = new Date(timestamp).toLocaleString();
    const metricTotal = sumGpuMetricPower(entry);
    const totalPower = parsePower(entry.gpuPowerW) ?? metricTotal;
    if (totalPower !== undefined) {
      total.push({ timestamp, label, value: totalPower });
      maxWatts = Math.max(maxWatts, totalPower);
    }

    for (const metric of entry.gpuMetrics ?? []) {
      if (metric.powerW === null || metric.powerW === undefined || !Number.isFinite(metric.powerW)) {
        continue;
      }
      const points = gpuPoints.get(metric.gpuIndex) ?? [];
      points.push({ timestamp, label, value: metric.powerW });
      gpuPoints.set(metric.gpuIndex, points);
      maxWatts = Math.max(maxWatts, metric.powerW);
    }
  }

  return {
    total,
    perGpu: [...gpuPoints.entries()]
      .sort(([a], [b]) => a - b)
      .map(([gpuIndex, points]) => ({ gpuIndex, points })),
    maxWatts,
    timeRange: Number.isFinite(minTime) && Number.isFinite(maxTime) ? { min: minTime, max: maxTime } : undefined,
  };
}

export type GpuMetricSeries = {
  perGpu: GpuPowerSeries[];
  timeRange?: {
    min: number;
    max: number;
  };
};

export function buildGpuMetricSeries(
  history: ProbeResult[],
  pick: (metric: GpuMetric) => number | null | undefined,
): GpuMetricSeries {
  const gpuPoints = new Map<number, PowerChartPoint[]>();
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;

  const chronologicalHistory = [...history].sort((a, b) => parseTime(a.checkedAt) - parseTime(b.checkedAt));
  for (const entry of chronologicalHistory) {
    const timestamp = parseTime(entry.checkedAt);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    minTime = Math.min(minTime, timestamp);
    maxTime = Math.max(maxTime, timestamp);
    const label = new Date(timestamp).toLocaleString();
    for (const metric of entry.gpuMetrics ?? []) {
      const value = pick(metric);
      if (value === null || value === undefined || !Number.isFinite(value)) {
        continue;
      }
      const points = gpuPoints.get(metric.gpuIndex) ?? [];
      points.push({ timestamp, label, value });
      gpuPoints.set(metric.gpuIndex, points);
    }
  }

  return {
    perGpu: [...gpuPoints.entries()]
      .sort(([a], [b]) => a - b)
      .map(([gpuIndex, points]) => ({ gpuIndex, points })),
    timeRange: Number.isFinite(minTime) && Number.isFinite(maxTime) ? { min: minTime, max: maxTime } : undefined,
  };
}

function parseTime(value: string | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

function parsePower(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const numericValue = Number.parseFloat(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function sumGpuMetricPower(entry: ProbeResult): number | undefined {
  let total = 0;
  let hasPower = false;
  for (const metric of entry.gpuMetrics ?? []) {
    if (metric.powerW === null || metric.powerW === undefined || !Number.isFinite(metric.powerW)) {
      continue;
    }
    total += metric.powerW;
    hasPower = true;
  }
  return hasPower ? total : undefined;
}
