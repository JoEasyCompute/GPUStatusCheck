export type Machine = {
  id?: number;
  name: string;
  ip: string;
  sshHost?: string;
  sshPort?: number;
  platform?: string;
  owner?: string;
  commissionDate?: string;
  active?: boolean;
  maintenance?: boolean;
  expectedGpuCount?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type FleetHistoryPoint = {
  pollRunId: number;
  startedAt: string;
  okCount: number;
  degradedCount: number;
  sshFailedCount: number;
  totalPowerW: number | null;
  averageTempC: number | null;
};

export type GpuProcess = {
  id?: number;
  probeResultId?: number;
  machineId?: number;
  pollRunId?: number;
  checkedAt?: string;
  gpuIndex: number;
  pid: number;
  processType?: string;
  smUtil?: number | null;
  memUtil?: number | null;
  encUtil?: number | null;
  decUtil?: number | null;
  command?: string;
  user?: string;
  elapsed?: string;
  processName?: string;
  commandLine?: string;
};

export type GpuMetric = {
  id?: number;
  probeResultId?: number;
  machineId?: number;
  pollRunId?: number;
  checkedAt?: string;
  gpuIndex: number;
  pciBusId?: string;
  gpuUtil?: number | null;
  memUtil?: number | null;
  tempC?: number | null;
  powerW?: number | null;
  powerLimitW?: number | null;
  graphicsClockMhz?: number | null;
  memoryClockMhz?: number | null;
};

export type GpuDownNote = {
  id?: number;
  machineId?: number;
  gpuIndex: number;
  downSince: string;
  recoveredAt?: string;
  note: string;
};

export type ProbeResult = {
  id?: number;
  pollRunId?: number;
  machineId?: number;
  checkedAt?: string;
  name: string;
  ip: string;
  platform?: string;
  owner?: string;
  commissionDate?: string;
  uptime?: string;
  sshOk: boolean;
  sshError?: string;
  sshUser?: string;
  remoteHost?: string;
  nvidiaSmiRc?: number | null;
  gpuCount?: number | null;
  gpuType?: string;
  gpuJobs?: string;
  gpuPowerW?: string;
  gpuAvgTempC?: string;
  busOffSuspected?: boolean;
  busOffReason?: string;
  nvidiaSmiOutput?: string;
  nvidiaSmiError?: string;
  kernelHits?: string;
  status: "ok" | "degraded" | "ssh_failed" | "unknown";
  durationMs?: number;
  processes?: GpuProcess[];
  gpuMetrics?: GpuMetric[];
};

export type PollRun = {
  id: number;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "complete" | "failed";
  machineCount: number;
  okCount: number;
  degradedCount: number;
  sshFailedCount: number;
  durationMs?: number;
  error?: string;
};

export type PollStatus = {
  running: boolean;
  startedAt?: string;
  elapsedMs?: number;
  currentRunId?: number;
  machineCount?: number;
  machinesPath: string;
  pollIntervalSeconds: number;
  lastSkippedAt?: string;
  lastFinishedAt?: string;
  lastError: string;
};

export type Summary = {
  total: number;
  ok: number;
  degraded: number;
  sshFailed: number;
  totalPowerW: number;
  averageTempC: number | null;
  lastRun?: PollRun;
};

export type RuntimeConfig = {
  machinesPath: string;
  dbPath: string;
  envPath: string;
  sshUser: string;
  jobs: number;
  pollIntervalSeconds: number;
  skipLogs: boolean;
  processArgsMaxChars: number;
  pollOnStartup: boolean;
  port: number;
};

export type EditableRuntimeConfig = {
  machinesPath: string;
  pollIntervalSeconds: number;
};

export type MachineWithLatest = Machine & {
  latest?: ProbeResult;
  activeGpuNotes?: GpuDownNote[];
};
