import { describe, expect, it } from "vitest";
import { matchesMachineStatusFilter } from "../src/client/machineFilters";
import { selectVisibleMachines } from "../src/client/agentAdmin";
import type { MachineWithLatest } from "../src/shared/types";

describe("machine status filter", () => {
  it("includes both OK and degraded machines in the combined filter", () => {
    expect(matchesMachineStatusFilter("ok", "ok_degraded")).toBe(true);
    expect(matchesMachineStatusFilter("degraded", "ok_degraded")).toBe(true);
    expect(matchesMachineStatusFilter("ssh_failed", "ok_degraded")).toBe(false);
    expect(matchesMachineStatusFilter(undefined, "ok_degraded")).toBe(false);
  });

  it("matches only explicit changed-host-key errors for the stale-key filter", () => {
    expect(matchesMachineStatusFilter("ssh_failed", "stale_ssh_key", "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")).toBe(true);
    expect(matchesMachineStatusFilter("ssh_failed", "stale_ssh_key", "Connection refused")).toBe(false);
    expect(matchesMachineStatusFilter("ok", "stale_ssh_key", "REMOTE HOST IDENTIFICATION HAS CHANGED")).toBe(false);
  });

  it("selects exactly the machines visible under the combined filter", () => {
    const machines = [
      machine(1, "ok"),
      machine(2, "degraded"),
      machine(3, "ssh_failed"),
    ];
    const visible = machines.filter((entry) => matchesMachineStatusFilter(entry.latest?.status, "ok_degraded"));
    expect(selectVisibleMachines(visible)).toEqual([1, 2]);
  });
});

function machine(id: number, status: string): MachineWithLatest {
  return {
    id,
    name: `machine-${id}`,
    ip: `10.0.0.${id}`,
    active: true,
    latest: { name: `machine-${id}`, ip: `10.0.0.${id}`, sshOk: status !== "ssh_failed", status: status as "ok" | "degraded" | "ssh_failed" },
  };
}
