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

export type NetworkChartSeries = {
  rx: PowerChartPoint[];
  tx: PowerChartPoint[];
  timeRange?: {
    min: number;
    max: number;
  };
};

/** Network in/out over time, converted from bytes/sec to Mbps. */
export function buildNetworkChartSeries(history: ProbeResult[]): NetworkChartSeries {
  const rx: PowerChartPoint[] = [];
  const tx: PowerChartPoint[] = [];
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
    if (entry.netRxBps !== null && entry.netRxBps !== undefined && Number.isFinite(entry.netRxBps)) {
      rx.push({ timestamp, label, value: bpsToMbps(entry.netRxBps) });
    }
    if (entry.netTxBps !== null && entry.netTxBps !== undefined && Number.isFinite(entry.netTxBps)) {
      tx.push({ timestamp, label, value: bpsToMbps(entry.netTxBps) });
    }
  }

  return {
    rx,
    tx,
    timeRange: Number.isFinite(minTime) && Number.isFinite(maxTime) ? { min: minTime, max: maxTime } : undefined,
  };
}

/** Time series of one field across a single GPU's metric rows, which may
 * span several machines when the card has been moved. */
export function buildMetricFieldSeries(
  metrics: GpuMetric[],
  pick: (metric: GpuMetric) => number | null | undefined,
): PowerChartPoint[] {
  const points: PowerChartPoint[] = [];
  const chronological = [...metrics].sort((a, b) => parseTime(a.checkedAt) - parseTime(b.checkedAt));
  for (const metric of chronological) {
    const timestamp = parseTime(metric.checkedAt);
    const value = pick(metric);
    if (!Number.isFinite(timestamp) || value === null || value === undefined || !Number.isFinite(value)) {
      continue;
    }
    points.push({ timestamp, label: new Date(timestamp).toLocaleString(), value });
  }
  return points;
}

/** Daily rollup series; each point is anchored at midnight UTC of its day. */
export function buildDailySeries<T extends { day: string }>(
  days: T[],
  pick: (day: T) => number | null | undefined,
): PowerChartPoint[] {
  const points: PowerChartPoint[] = [];
  for (const entry of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    const timestamp = Date.parse(`${entry.day}T00:00:00Z`);
    const value = pick(entry);
    if (!Number.isFinite(timestamp) || value === null || value === undefined || !Number.isFinite(value)) {
      continue;
    }
    points.push({ timestamp, label: entry.day, value });
  }
  return points;
}

/** Time series of a single numeric field straight off each probe row. */
export function buildProbeFieldSeries(
  history: ProbeResult[],
  pick: (entry: ProbeResult) => number | null | undefined,
): PowerChartPoint[] {
  const points: PowerChartPoint[] = [];
  const chronologicalHistory = [...history].sort((a, b) => parseTime(a.checkedAt) - parseTime(b.checkedAt));
  for (const entry of chronologicalHistory) {
    const timestamp = parseTime(entry.checkedAt);
    const value = pick(entry);
    if (!Number.isFinite(timestamp) || value === null || value === undefined || !Number.isFinite(value)) {
      continue;
    }
    points.push({ timestamp, label: new Date(timestamp).toLocaleString(), value });
  }
  return points;
}

export function bpsToMbps(bytesPerSecond: number): number {
  return Number(((bytesPerSecond * 8) / 1_000_000).toFixed(2));
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
