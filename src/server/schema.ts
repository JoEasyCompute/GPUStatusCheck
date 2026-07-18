import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const machines = sqliteTable("machines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  ip: text("ip").notNull(),
  sshHost: text("ssh_host").notNull(),
  sshPort: integer("ssh_port").notNull(),
  platform: text("platform").notNull().default(""),
  owner: text("owner").notNull().default(""),
  commissionDate: text("commission_date").notNull().default(""),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const pollRuns = sqliteTable("poll_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull(),
  machineCount: integer("machine_count").notNull(),
  okCount: integer("ok_count").notNull().default(0),
  degradedCount: integer("degraded_count").notNull().default(0),
  sshFailedCount: integer("ssh_failed_count").notNull().default(0),
  durationMs: integer("duration_ms"),
  error: text("error").notNull().default(""),
});

export const probeResults = sqliteTable("probe_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pollRunId: integer("poll_run_id").notNull(),
  machineId: integer("machine_id").notNull(),
  checkedAt: text("checked_at").notNull(),
  status: text("status").notNull(),
  sshOk: integer("ssh_ok", { mode: "boolean" }).notNull(),
  sshError: text("ssh_error").notNull().default(""),
  remoteHost: text("remote_host").notNull().default(""),
  uptime: text("uptime").notNull().default(""),
  nvidiaSmiRc: integer("nvidia_smi_rc"),
  gpuCount: integer("gpu_count"),
  gpuType: text("gpu_type").notNull().default(""),
  gpuJobs: text("gpu_jobs").notNull().default(""),
  gpuPowerW: real("gpu_power_w"),
  gpuAvgTempC: real("gpu_avg_temp_c"),
  busOffSuspected: integer("bus_off_suspected", { mode: "boolean" }).notNull().default(false),
  busOffReason: text("bus_off_reason").notNull().default(""),
  kernelHits: text("kernel_hits").notNull().default(""),
  nvidiaSmiOutput: text("nvidia_smi_output").notNull().default(""),
  nvidiaSmiError: text("nvidia_smi_error").notNull().default(""),
  durationMs: integer("duration_ms"),
});

export const gpuProcesses = sqliteTable("gpu_processes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  probeResultId: integer("probe_result_id").notNull(),
  machineId: integer("machine_id").notNull(),
  pollRunId: integer("poll_run_id").notNull(),
  checkedAt: text("checked_at").notNull(),
  gpuIndex: integer("gpu_index").notNull(),
  pid: integer("pid").notNull(),
  processType: text("process_type").notNull().default(""),
  smUtil: integer("sm_util"),
  memUtil: integer("mem_util"),
  encUtil: integer("enc_util"),
  decUtil: integer("dec_util"),
  command: text("command").notNull().default(""),
  user: text("user").notNull().default(""),
  elapsed: text("elapsed").notNull().default(""),
  processName: text("process_name").notNull().default(""),
  commandLine: text("command_line").notNull().default(""),
});

export const gpuDownEvents = sqliteTable("gpu_down_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  machineId: integer("machine_id").notNull(),
  gpuIndex: integer("gpu_index").notNull(),
  downSince: text("down_since").notNull(),
  recoveredAt: text("recovered_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
