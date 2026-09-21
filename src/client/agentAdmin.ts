import type { AgentOperationDetail, MachineWithLatest } from "../shared/types";

export function toggleMachineSelection(selected: number[], machineId: number): number[] {
  return selected.includes(machineId) ? selected.filter((id) => id !== machineId) : [...selected, machineId];
}

export function selectVisibleMachines(selected: number[], machines: MachineWithLatest[]): number[] {
  const next = new Set(selected);
  for (const machine of machines) {
    if (machine.active !== false && machine.id !== undefined) next.add(machine.id);
  }
  return [...next];
}

export function eligibleRetryMachineIds(operation: AgentOperationDetail): number[] {
  return operation.items
    .filter((item) => item.status === "failed" || item.status === "skipped" || item.status === "interrupted")
    .map((item) => item.machineId);
}

export function agentPresence(machine: MachineWithLatest): "installed" | "absent" | "unknown" {
  if (machine.latest?.agentVersion) return "installed";
  return machine.latest?.sshOk === true ? "absent" : "unknown";
}
