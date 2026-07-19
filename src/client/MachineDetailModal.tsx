import { useState } from "react";
import type { GpuProcess, MachineWithLatest, ProbeResult } from "../shared/types";
import { formatStatus, formatTime } from "./formatters";
import { GpuCharts } from "./PowerCharts";

export function MachineDetailModal({
  machine,
  history,
  processes,
  onClose,
  onToggleMaintenance,
  onCopySsh,
}: {
  machine: MachineWithLatest;
  history: ProbeResult[];
  processes: GpuProcess[];
  onClose: () => void;
  onToggleMaintenance: (machine: MachineWithLatest) => void;
  onCopySsh: (machine: MachineWithLatest) => Promise<void> | void;
}) {
  const [copied, setCopied] = useState(false);
  const latest = history[0] ?? machine.latest;
  const copySsh = async () => {
    await onCopySsh(machine);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={`${machine.name} details`} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{machine.name}</h2>
          <span className={`status ${latest?.status ?? "unknown"}`}>{formatStatus(latest?.status)}</span>
          {machine.maintenance ? <span className="chip maintenance">maintenance</span> : null}
          <button className="ip-copy" title="Copy SSH command" onClick={() => void copySsh()}>
            {machine.ip}
          </button>
          {copied ? <span className="chip copied">copied</span> : null}
          <button className="maintenance-toggle" onClick={() => onToggleMaintenance(machine)}>
            {machine.maintenance ? "Exit maintenance" : "Enter maintenance"}
          </button>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <DetailPane machine={machine} history={history} processes={processes} />
      </div>
    </div>
  );
}

function DetailPane({ machine, history, processes }: { machine: MachineWithLatest; history: ProbeResult[]; processes: GpuProcess[] }) {
  const [processSearch, setProcessSearch] = useState("");
  const latest = history[0] ?? machine.latest;
  const processNeedle = processSearch.trim().toLowerCase();
  const filteredProcesses = processes.filter((process) => {
    if (!processNeedle) {
      return true;
    }
    return [
      process.commandLine,
      process.command,
      process.processName,
      process.user,
      String(process.pid),
      `gpu ${process.gpuIndex}`,
    ].filter(Boolean).some((value) => value!.toLowerCase().includes(processNeedle));
  });
  const processesByGpu = groupProcessesByGpu(filteredProcesses);
  const errorText = latest?.sshError || latest?.nvidiaSmiError || "";
  const busOffText = latest?.busOffReason || (latest?.busOffSuspected ? "bus-off suspected" : "");

  return (
    <aside className="detail-panel">
      <dl className="metadata">
        <div><dt>Location</dt><dd>{machine.location || "-"}</dd></div>
        <div><dt>Platform</dt><dd>{machine.platform || "-"}</dd></div>
        <div><dt>Owner</dt><dd>{machine.owner || "-"}</dd></div>
        <div><dt>Remote</dt><dd>{latest?.remoteHost || "-"}</dd></div>
        <div><dt>SSH user</dt><dd>{latest?.sshUser || "-"}</dd></div>
        <div><dt>Uptime</dt><dd>{latest?.uptime || "-"}</dd></div>
        <div><dt>GPU type</dt><dd>{latest?.gpuType || "-"}</dd></div>
        <div><dt>GPU jobs</dt><dd className="mono">{latest?.gpuJobs || "-"}</dd></div>
        <div><dt>SSH error</dt><dd>{errorText || "-"}</dd></div>
        <div><dt>Bus-off</dt><dd>{busOffText || "-"}</dd></div>
        <div><dt>Notes</dt><dd>{formatMachineNotes(machine)}</dd></div>
      </dl>
      {latest?.kernelHits ? <pre className="evidence-block">{latest.kernelHits}</pre> : null}

      <details className="detail-section" open>
        <summary>GPU history</summary>
        <GpuCharts history={history} />
      </details>

      <details className="detail-section">
        <summary>Process history</summary>
        <input
          className="process-search"
          value={processSearch}
          onChange={(event) => setProcessSearch(event.target.value)}
          placeholder="Search PID, GPU, user, command"
        />
        <div className="process-list">
          {processes.length === 0 ? <p>No recent GPU processes recorded.</p> : null}
          {processes.length > 0 && processesByGpu.length === 0 ? <p>No GPU processes match the filter.</p> : null}
          {processesByGpu.map(([gpuIndex, gpuProcesses]) => (
            <div className="gpu-process-group" key={gpuIndex}>
              <div className="gpu-process-heading">
                <strong>GPU {gpuIndex}</strong>
                <span>{gpuProcesses.length} process{gpuProcesses.length === 1 ? "" : "es"}</span>
              </div>
              {gpuProcesses.map((process) => (
                <div className="process-row" key={`${process.id}-${process.pid}-${process.gpuIndex}`}>
                  <span className="pid">PID {process.pid}</span>
                  <span>{process.user || "-"}</span>
                  <span>{process.elapsed || "-"}</span>
                  <span className="command">{process.commandLine || process.command || "-"}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </details>

      <details className="detail-section">
        <summary>Probe history</summary>
        <div className="history-list">
          {history.length === 0 ? <p>No probe history recorded.</p> : null}
          {history.slice(0, 20).map((entry, index) => (
            <div className="history-row" key={entry.id ?? `${entry.checkedAt}-${index}`}>
              <span className={`status ${entry.status}`}>{formatStatus(entry.status)}</span>
              <span>{formatTime(entry.checkedAt)}</span>
              <span className="mono">{entry.gpuJobs || "-"}</span>
              <span>{entry.gpuPowerW ? `${entry.gpuPowerW} W` : "-"}</span>
              <span>{entry.gpuAvgTempC ? `${entry.gpuAvgTempC} °C` : "-"}</span>
            </div>
          ))}
        </div>
      </details>
    </aside>
  );
}

function groupProcessesByGpu(processes: GpuProcess[]): Array<[number, GpuProcess[]]> {
  const groups = new Map<number, GpuProcess[]>();
  for (const process of processes) {
    const group = groups.get(process.gpuIndex) ?? [];
    group.push(process);
    groups.set(process.gpuIndex, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b);
}

function formatMachineNotes(machine: MachineWithLatest): string {
  const notes = machine.activeGpuNotes ?? [];
  return notes.length === 0 ? "-" : notes.map((note) => note.note).join("; ");
}
