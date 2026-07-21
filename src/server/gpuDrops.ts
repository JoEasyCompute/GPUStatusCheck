/**
 * Per-card GPU drop detection.
 *
 * A machine's expected roster is every GPU UUID whose latest sighting points at
 * that machine (see listMachineRoster in db.ts). Diffing the roster against the
 * UUIDs a probe just reported identifies exactly which physical card vanished —
 * the index-based gpu_down_events path cannot do this, because it only fires on
 * kernel-log bus-off evidence and then flags every slot at once.
 */

export type RosterEntry = {
  uuid: string;
  gpuIndex: number | null;
  gpuType: string;
};

export type DropDetection = {
  /** Cards in the roster that this probe did not report. */
  dropped: RosterEntry[];
  /** UUIDs the probe reported, used to close open incident members. */
  visible: Set<string>;
  /** Every rostered card is missing (driver crash) rather than a subset. */
  wholeMachine: boolean;
  /** Detection is meaningless for this probe (unreachable host, empty roster). */
  skipped: boolean;
};

export type DropIncidentMember = {
  id: number;
  uuid: string;
  gpuIndex: number | null;
  gpuType: string;
  droppedAt: string;
  recoveredAt?: string;
  recoveryAnnouncedAt?: string;
};

export type DropIncident = {
  id: number;
  machineId: number;
  machineName: string;
  maintenance: boolean;
  owner: string;
  channel: string;
  slackTs: string;
  openedAt: string;
  closedAt?: string;
  announcedAt?: string;
  allRecoveredAnnouncedAt?: string;
  visibleCount: number;
  expectedCount: number;
  wholeMachine: boolean;
  reason: string;
  members: DropIncidentMember[];
};

export type ProbeRoster = {
  sshOk: boolean;
  visibleUuids: string[];
};

/**
 * Detection only runs on a probe that actually reached the host: an
 * unreachable machine tells us nothing about its cards, and announcing them
 * would turn one host outage into N false GPU-drop alerts.
 */
export function detectGpuDrops(roster: RosterEntry[], probe: ProbeRoster): DropDetection {
  const visible = new Set(probe.visibleUuids.filter(Boolean));
  if (!probe.sshOk || roster.length === 0) {
    return { dropped: [], visible, wholeMachine: false, skipped: true };
  }
  const dropped = roster.filter((entry) => !visible.has(entry.uuid));
  return {
    dropped,
    visible,
    wholeMachine: dropped.length === roster.length,
    skipped: false,
  };
}

export function formatDowntime(fromIso: string, toIso: string): string {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
