import type { AgentOperationDetail, MachineWithLatest } from "../shared/types";

export function toggleMachineSelection(selected: number[], machineId: number): number[] {
  return selected.includes(machineId) ? selected.filter((id) => id !== machineId) : [...selected, machineId];
}

export function selectVisibleMachines(machines: MachineWithLatest[]): number[] {
  const next = new Set<number>();
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
  const latest = machine.latest?.sshOk === false ? machine.lastSuccessful ?? machine.latest : machine.latest;
  if (latest?.agentVersion) return "installed";
  return machine.latest?.sshOk === true ? "absent" : "unknown";
}

export function installedAgentMachineIds(machines: MachineWithLatest[]): number[] {
  return machines
    .filter((machine) => machine.active !== false && machine.id !== undefined && agentPresence(machine) === "installed")
    .map((machine) => machine.id!);
}
