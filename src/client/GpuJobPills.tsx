import type { ProbeResult } from "../shared/types";
import { formatNullable, formatPower } from "./formatters";

export function GpuJobPills({ latest }: { latest?: ProbeResult }) {
  const jobs = latest?.gpuJobs ?? "";
  const gpuCount = latest?.gpuCount ?? jobs.length;
  const width = Math.max(gpuCount || 0, jobs.length);
  if (!latest || width < 1) {
    return <span>-</span>;
  }

  return (
    <div className="gpu-pills" onClick={(event) => event.stopPropagation()}>
      {Array.from({ length: width }, (_, gpuIndex) => {
        const state = jobs[gpuIndex] ?? "x";
        const metric = latest.gpuMetrics?.find((item) => item.gpuIndex === gpuIndex);
        const gpuProcesses = latest.processes?.filter((process) => process.gpuIndex === gpuIndex) ?? [];
        return (
          <span className={`gpu-pill ${pillClass(state)}`} key={gpuIndex} tabIndex={0}>
            {gpuIndex}
            <span className="gpu-tooltip" role="tooltip">
              <strong>GPU {gpuIndex}</strong>
              <span>PCIe: {metric?.pciBusId || "-"}</span>
              <span>Status: {pillStatusLabel(state)}</span>
              <span>GPU util: {formatNullable(metric?.gpuUtil, "%")}</span>
              <span>Mem util: {formatNullable(metric?.memUtil, "%")}</span>
              <span>Temp: {formatNullable(metric?.tempC, " C")}</span>
              <span>Power: {formatPower(metric?.powerW, metric?.powerLimitW)}</span>
              <span>GPU clock: {formatNullable(metric?.graphicsClockMhz, " MHz")}</span>
              <span>Mem clock: {formatNullable(metric?.memoryClockMhz, " MHz")}</span>
              <span>Jobs:</span>
              {gpuProcesses.length === 0 ? <em>No running GPU process recorded</em> : gpuProcesses.slice(0, 4).map((process) => (
                <em key={`${process.pid}-${process.commandLine || process.command}`}>
                  PID {process.pid} {process.user ? `${process.user} ` : ""}{process.commandLine || process.command || "-"}
                </em>
              ))}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function pillClass(state: string): string {
  if (state === "D") {
    return "busy";
  }
  if (state === "E") {
    return "error";
  }
  return "idle";
}

function pillStatusLabel(state: string): string {
  if (state === "D") {
    return "running";
  }
  if (state === "E") {
    return "error";
  }
  return "idle";
}
