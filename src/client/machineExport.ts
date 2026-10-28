import type { GpuIdentity, MachineWithLatest } from "../shared/types";

const CSV_HEADER = ["Server hostname", "IP address", "GPU UUID", "GPU position"];

export function buildVisibleMachineGpuCsv(machines: MachineWithLatest[], gpus: GpuIdentity[]): string {
  const rows = [CSV_HEADER.map(escapeCsvCell).join(",")];
  for (const machine of machines) {
    if (machine.id === undefined) continue;
    const machineGpus = gpus
      .filter((gpu) => gpu.lastMachineId === machine.id)
      .sort((a, b) => (a.lastGpuIndex ?? Number.MAX_SAFE_INTEGER) - (b.lastGpuIndex ?? Number.MAX_SAFE_INTEGER)
        || a.uuid.localeCompare(b.uuid));
    for (const gpu of machineGpus) {
      rows.push([
        machine.name,
        machine.ip,
        gpu.uuid,
        gpu.lastGpuIndex === null ? "" : String(gpu.lastGpuIndex),
      ].map(escapeCsvCell).join(","));
    }
  }
  return `${rows.join("\r\n")}\r\n`;
}

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
