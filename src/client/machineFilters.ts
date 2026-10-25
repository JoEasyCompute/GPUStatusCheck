export type MachineStatusFilter = "all" | "not_ok" | "ok" | "degraded" | "ssh_failed" | "ok_degraded";

export function matchesMachineStatusFilter(status: string | undefined, filter: MachineStatusFilter): boolean {
  const currentStatus = status ?? "unknown";
  if (filter === "all") return true;
  if (filter === "not_ok") return currentStatus !== "ok";
  if (filter === "ok_degraded") return currentStatus === "ok" || currentStatus === "degraded";
  return currentStatus === filter;
}
