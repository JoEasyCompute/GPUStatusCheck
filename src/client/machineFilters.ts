import { isChangedHostKeyError } from "../shared/sshHostKey";

export type MachineStatusFilter = "all" | "not_ok" | "ok" | "degraded" | "ssh_failed" | "ok_degraded" | "stale_ssh_key";

export function matchesMachineStatusFilter(status: string | undefined, filter: MachineStatusFilter, sshError?: string): boolean {
  const currentStatus = status ?? "unknown";
  if (filter === "all") return true;
  if (filter === "not_ok") return currentStatus !== "ok";
  if (filter === "ok_degraded") return currentStatus === "ok" || currentStatus === "degraded";
  if (filter === "stale_ssh_key") return currentStatus === "ssh_failed" && isChangedHostKeyError(sshError);
  return currentStatus === filter;
}
