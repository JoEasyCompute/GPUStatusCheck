import { describe, expect, it } from "vitest";
import { buildPowerChartSeries } from "../src/client/powerChartData";
import type { ProbeResult } from "../src/shared/types";

describe("power chart data", () => {
  it("orders history oldest first and builds total plus per-gpu power series", () => {
    const history: ProbeResult[] = [
      {
        id: 2,
        name: "alpha",
        ip: "10.0.0.1",
        sshOk: true,
        status: "ok",
        checkedAt: "2026-07-17T10:05:00.000Z",
        gpuPowerW: "330.5",
        gpuMetrics: [
          { gpuIndex: 0, powerW: 210 },
          { gpuIndex: 1, powerW: 120.5 },
        ],
      },
      {
        id: 1,
        name: "alpha",
        ip: "10.0.0.1",
        sshOk: true,
        status: "ok",
        checkedAt: "2026-07-17T10:00:00.000Z",
        gpuPowerW: "300",
        gpuMetrics: [
          { gpuIndex: 0, powerW: 200 },
          { gpuIndex: 1, powerW: 100 },
        ],
      },
    ];

    const series = buildPowerChartSeries(history);

    expect(series.total.map((point) => point.value)).toEqual([300, 330.5]);
    expect(series.perGpu.map((gpu) => gpu.gpuIndex)).toEqual([0, 1]);
    expect(series.perGpu[0]?.points.map((point) => point.value)).toEqual([200, 210]);
    expect(series.perGpu[1]?.points.map((point) => point.value)).toEqual([100, 120.5]);
    expect(series.maxWatts).toBe(330.5);
    expect(series.timeRange).toEqual({
      min: Date.parse("2026-07-17T10:00:00.000Z"),
      max: Date.parse("2026-07-17T10:05:00.000Z"),
    });
  });

  it("falls back to summing gpu metrics when total power is missing", () => {
    const series = buildPowerChartSeries([
      {
        name: "alpha",
        ip: "10.0.0.1",
        sshOk: true,
        status: "ok",
        checkedAt: "2026-07-17T10:00:00.000Z",
        gpuMetrics: [
          { gpuIndex: 0, powerW: 125 },
          { gpuIndex: 1, powerW: 75 },
        ],
      },
    ]);

    expect(series.total.map((point) => point.value)).toEqual([200]);
    expect(series.maxWatts).toBe(200);
  });
});
