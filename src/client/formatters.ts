import type { PollStatus } from "../shared/types";

export function formatNullable(value: number | null | undefined, suffix: string): string {
  return value === null || value === undefined ? "-" : `${value}${suffix}`;
}

export function formatPower(current: number | null | undefined, max: number | null | undefined): string {
  const currentText = formatNullable(current, " W");
  const maxText = formatNullable(max, " W");
  return `${currentText} / ${maxText}`;
}

const statusLabels: Record<string, string> = {
  ok: "OK",
  degraded: "Degraded",
  ssh_failed: "SSH failed",
  unknown: "Unknown",
};

export function formatStatus(status?: string): string {
  if (!status) {
    return statusLabels.unknown;
  }
  return statusLabels[status] ?? status;
}

export function formatTime(value?: string): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

export function formatElapsed(status: PollStatus | undefined, now: number): string {
  if (!status?.running || !status.startedAt) {
    return "-";
  }
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(status.startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
