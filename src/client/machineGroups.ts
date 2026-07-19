import type { MachineWithLatest } from "../shared/types";

export type MachineGroupBy = "none" | "owner" | "location";

export type MachineGroup = { label?: string; machines: MachineWithLatest[] };

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
