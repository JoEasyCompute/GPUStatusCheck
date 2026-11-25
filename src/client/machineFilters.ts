import type { IommuStatus } from "../shared/types";
import { isChangedHostKeyError } from "../shared/sshHostKey";

export type MachineStatusFilter = "all" | "not_ok" | "ok" | "degraded" | "ssh_failed" | "ok_degraded" | "stale_ssh_key" | "iommu_not_enabled";

export function matchesMachineStatusFilter(
  status: string | undefined,
  filter: MachineStatusFilter,
  sshError?: string,
  iommuStatus?: IommuStatus,
): boolean {
  const currentStatus = status ?? "unknown";
  if (filter === "all") return true;
  if (filter === "not_ok") return currentStatus !== "ok";
  if (filter === "ok_degraded") return currentStatus === "ok" || currentStatus === "degraded";
  if (filter === "iommu_not_enabled") return iommuStatus === "inactive";
  if (filter === "stale_ssh_key") return currentStatus === "ssh_failed" && isChangedHostKeyError(sshError);
  return currentStatus === filter;
}
