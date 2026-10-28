import { describe, expect, it } from "vitest";
import { buildVisibleMachineGpuCsv } from "../src/client/machineExport";
import type { GpuIdentity, MachineWithLatest } from "../src/shared/types";

describe("visible machine GPU CSV", () => {
  it("writes one row per known GPU in the filtered machines and omits machines without GPUs", () => {
    const machines: MachineWithLatest[] = [
      { id: 1, name: 'Rack, "Alpha"', ip: "77.93.143.2:63068" },
      { id: 2, name: "Empty", ip: "10.0.0.2" },
    ];
    const gpus: GpuIdentity[] = [
      gpu("GPU-aaa", 1, 0),
      gpu("GPU-bbb", 1, 3),
      gpu("GPU-ccc", 3, 1),
      gpu("GPU-ddd", 1, null),
    ];

    expect(buildVisibleMachineGpuCsv(machines, gpus)).toBe([
      "Server hostname,IP address,GPU UUID,GPU position",
      '"Rack, ""Alpha""",77.93.143.2:63068,GPU-aaa,0',
      '"Rack, ""Alpha""",77.93.143.2:63068,GPU-bbb,3',
      '"Rack, ""Alpha""",77.93.143.2:63068,GPU-ddd,',
      "",
    ].join("\r\n"));
  });

  it("returns just the header when no visible machine has a known GPU", () => {
    expect(buildVisibleMachineGpuCsv([{ id: 1, name: "Empty", ip: "10.0.0.1" }], [])).toBe(
      "Server hostname,IP address,GPU UUID,GPU position\r\n",
    );
  });
});

function gpu(uuid: string, lastMachineId: number, lastGpuIndex: number | null): GpuIdentity {
  return {
    uuid,
    gpuType: "5090",
    firstSeenAt: "2026-10-28T00:00:00Z",
    lastSeenAt: "2026-10-28T00:00:00Z",
    lastMachineId,
    lastGpuIndex,
    lastOwner: "owner",
  };
}
