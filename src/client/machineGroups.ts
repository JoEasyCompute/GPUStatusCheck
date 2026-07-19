import type { MachineWithLatest } from "../shared/types";

export type MachineGroupBy = "none" | "owner" | "location";

export type MachineGroup = { label?: string; machines: MachineWithLatest[] };

export type MachineGroupStats = {
  total: number;
  ok: number;
  degraded: number;
  sshFailed: number;
  totalPowerW: number;
  averagePowerW: number | null;
  averageTempC: number | null;
};

export function computeGroupStats(machines: MachineWithLatest[]): MachineGroupStats {
  let ok = 0;
  let degraded = 0;
  let sshFailed = 0;
  let totalPowerW = 0;
  let powerCount = 0;
  let tempTotal = 0;
  let tempCount = 0;

  for (const machine of machines) {
    const latest = machine.latest;
    if (latest?.status === "ok") ok += 1;
    else if (latest?.status === "degraded") degraded += 1;
    else if (latest?.status === "ssh_failed") sshFailed += 1;

    const power = Number(latest?.gpuPowerW);
    if (latest?.gpuPowerW && Number.isFinite(power)) {
      totalPowerW += power;
      powerCount += 1;
    }
    const temp = Number(latest?.gpuAvgTempC);
    if (latest?.gpuAvgTempC && Number.isFinite(temp)) {
      tempTotal += temp;
      tempCount += 1;
    }
  }

  return {
    total: machines.length,
    ok,
    degraded,
    sshFailed,
    totalPowerW,
    averagePowerW: powerCount > 0 ? totalPowerW / powerCount : null,
    averageTempC: tempCount > 0 ? tempTotal / tempCount : null,
  };
}

export function buildMachineGroups(machines: MachineWithLatest[], groupBy: MachineGroupBy): MachineGroup[] {
  const byName = [...machines].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (groupBy === "none") {
    return [{ machines: byName }];
  }
  const groups = new Map<string, MachineWithLatest[]>();
  for (const machine of byName) {
    const key = ((groupBy === "owner" ? machine.owner : machine.location) ?? "").trim();
    const group = groups.get(key) ?? [];
    group.push(machine);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    })
    .map(([label, groupMachines]) => ({ label, machines: groupMachines }));
}
