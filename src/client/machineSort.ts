import type { MachineWithLatest } from "../shared/types";

export type MachineSortKey = "name" | "status" | "ip" | "platform" | "owner" | "gpuType" | "gpus" | "jobs" | "notes" | "power" | "temp" | "checked";

export type MachineSort = {
  key: MachineSortKey;
  direction: "asc" | "desc";
};

export function sortMachines(machines: MachineWithLatest[], sort: MachineSort): MachineWithLatest[] {
  return [...machines].sort((left, right) => {
    const comparison = compareValues(sortValue(left, sort.key), sortValue(right, sort.key));
    return sort.direction === "asc" ? comparison : -comparison;
  });
}

function sortValue(machine: MachineWithLatest, key: MachineSortKey): string | number {
  switch (key) {
    case "name":
      return machine.name;
    case "status":
      return machine.latest?.status ?? "unknown";
    case "ip":
      return machine.ip;
    case "platform":
      return machine.platform ?? "";
    case "owner":
      return machine.owner ?? "";
    case "gpuType":
      return machine.latest?.gpuType ?? "";
    case "gpus":
      return machine.latest?.gpuCount ?? -1;
    case "jobs":
      return machine.latest?.gpuJobs ?? "";
    case "notes":
      return machine.activeGpuNotes?.map((note) => note.note).join(" ") ?? "";
    case "power":
      return numericOrMissing(machine.latest?.gpuPowerW);
    case "temp":
      return numericOrMissing(machine.latest?.gpuAvgTempC);
    case "checked":
      return machine.latest?.checkedAt ? Date.parse(machine.latest.checkedAt) : 0;
  }
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

function numericOrMissing(value: string | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
}
