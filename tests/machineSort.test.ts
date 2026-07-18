import { describe, expect, it } from "vitest";
import { sortMachines } from "../src/client/machineSort";
import type { MachineWithLatest } from "../src/shared/types";

describe("machine table sorting", () => {
  const machines: MachineWithLatest[] = [
    {
      id: 1,
      name: "beta",
      ip: "10.0.0.2",
      latest: { name: "beta", ip: "10.0.0.2", sshOk: true, status: "ok", gpuPowerW: "50.0", checkedAt: "2026-07-17T10:00:00.000Z" },
    },
    {
      id: 2,
      name: "alpha",
      ip: "10.0.0.1",
      latest: { name: "alpha", ip: "10.0.0.1", sshOk: true, status: "degraded", gpuPowerW: "120.0", checkedAt: "2026-07-17T10:05:00.000Z" },
    },
  ];

  it("sorts strings ascending and descending", () => {
    expect(sortMachines(machines, { key: "name", direction: "asc" }).map((machine) => machine.name)).toEqual(["alpha", "beta"]);
    expect(sortMachines(machines, { key: "name", direction: "desc" }).map((machine) => machine.name)).toEqual(["beta", "alpha"]);
  });

  it("sorts numeric and time columns", () => {
    expect(sortMachines(machines, { key: "power", direction: "asc" }).map((machine) => machine.name)).toEqual(["beta", "alpha"]);
    expect(sortMachines(machines, { key: "checked", direction: "desc" }).map((machine) => machine.name)).toEqual(["alpha", "beta"]);
  });
});
