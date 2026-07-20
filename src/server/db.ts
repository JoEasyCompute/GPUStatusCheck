import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { FleetHistoryPoint, GpuDownNote, GpuMetric, GpuProcess, GroupHistoryPoint, Machine, MachineWithLatest, PollRun, ProbeResult, Summary } from "../shared/types";

type Sqlite = Database.Database;

export type DashboardDatabase = ReturnType<typeof createDatabase>;

export function createDatabase(dbPath: string) {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  function migrate(): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        ip TEXT NOT NULL,
        ssh_host TEXT NOT NULL,
        ssh_port INTEGER NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        commission_date TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS poll_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        machine_count INTEGER NOT NULL,
        ok_count INTEGER NOT NULL DEFAULT 0,
        degraded_count INTEGER NOT NULL DEFAULT 0,
        ssh_failed_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        error TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS probe_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_run_id INTEGER NOT NULL,
        machine_id INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        status TEXT NOT NULL,
        ssh_ok INTEGER NOT NULL,
        ssh_error TEXT NOT NULL DEFAULT '',
        remote_host TEXT NOT NULL DEFAULT '',
        uptime TEXT NOT NULL DEFAULT '',
        nvidia_smi_rc INTEGER,
        gpu_count INTEGER,
        gpu_type TEXT NOT NULL DEFAULT '',
        gpu_jobs TEXT NOT NULL DEFAULT '',
        gpu_power_w REAL,
        gpu_avg_temp_c REAL,
        bus_off_suspected INTEGER NOT NULL DEFAULT 0,
        bus_off_reason TEXT NOT NULL DEFAULT '',
        kernel_hits TEXT NOT NULL DEFAULT '',
        nvidia_smi_output TEXT NOT NULL DEFAULT '',
        nvidia_smi_error TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        FOREIGN KEY(machine_id) REFERENCES machines(id),
        FOREIGN KEY(poll_run_id) REFERENCES poll_runs(id)
      );

      CREATE TABLE IF NOT EXISTS gpu_processes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        probe_result_id INTEGER NOT NULL,
        machine_id INTEGER NOT NULL,
        poll_run_id INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        gpu_index INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        process_type TEXT NOT NULL DEFAULT '',
        sm_util INTEGER,
        mem_util INTEGER,
        enc_util INTEGER,
        dec_util INTEGER,
        command TEXT NOT NULL DEFAULT '',
        user TEXT NOT NULL DEFAULT '',
        elapsed TEXT NOT NULL DEFAULT '',
        process_name TEXT NOT NULL DEFAULT '',
        command_line TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(probe_result_id) REFERENCES probe_results(id)
      );

      CREATE TABLE IF NOT EXISTS gpu_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        probe_result_id INTEGER NOT NULL,
        machine_id INTEGER NOT NULL,
        poll_run_id INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        gpu_index INTEGER NOT NULL,
        pci_bus_id TEXT NOT NULL DEFAULT '',
        gpu_util INTEGER,
        mem_util INTEGER,
        temp_c REAL,
        power_w REAL,
        power_limit_w REAL,
        graphics_clock_mhz INTEGER,
        memory_clock_mhz INTEGER,
        FOREIGN KEY(probe_result_id) REFERENCES probe_results(id)
      );

      CREATE TABLE IF NOT EXISTS alert_states (
        machine_name TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gpu_down_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id INTEGER NOT NULL,
        gpu_index INTEGER NOT NULL,
        down_since TEXT NOT NULL,
        recovered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(machine_id) REFERENCES machines(id)
      );

      CREATE INDEX IF NOT EXISTS idx_probe_results_machine_checked ON probe_results(machine_id, checked_at);
      CREATE INDEX IF NOT EXISTS idx_probe_results_status_checked ON probe_results(status, checked_at);
      CREATE INDEX IF NOT EXISTS idx_gpu_processes_machine_checked ON gpu_processes(machine_id, checked_at);
      CREATE INDEX IF NOT EXISTS idx_gpu_processes_probe ON gpu_processes(probe_result_id);
      CREATE INDEX IF NOT EXISTS idx_gpu_metrics_machine_checked ON gpu_metrics(machine_id, checked_at);
      CREATE INDEX IF NOT EXISTS idx_gpu_metrics_probe ON gpu_metrics(probe_result_id);
      CREATE INDEX IF NOT EXISTS idx_gpu_down_events_active ON gpu_down_events(machine_id, gpu_index, recovered_at);
      CREATE INDEX IF NOT EXISTS idx_poll_runs_started ON poll_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_probe_results_checked ON probe_results(checked_at);
      CREATE INDEX IF NOT EXISTS idx_gpu_processes_checked ON gpu_processes(checked_at);
      CREATE INDEX IF NOT EXISTS idx_gpu_metrics_checked ON gpu_metrics(checked_at);
      CREATE INDEX IF NOT EXISTS idx_probe_results_run ON probe_results(poll_run_id);
    `);
    ensureColumn(db, "machines", "maintenance", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "machines", "location", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "machines", "expected_gpu_count", "INTEGER");
    ensureColumn(db, "probe_results", "gpu_type", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "probe_results", "ssh_user", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "probe_results", "net_rx_bps", "REAL");
    ensureColumn(db, "probe_results", "net_tx_bps", "REAL");
    ensureColumn(db, "gpu_metrics", "pci_bus_id", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "gpu_metrics", "power_limit_w", "REAL");
    ensureColumn(db, "gpu_metrics", "graphics_clock_mhz", "INTEGER");
    ensureColumn(db, "gpu_metrics", "memory_clock_mhz", "INTEGER");
  }

  function upsertMachine(machine: Machine): Machine {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO machines (name, ip, ssh_host, ssh_port, platform, owner, commission_date, location, active, created_at, updated_at)
      VALUES (@name, @ip, @sshHost, @sshPort, @platform, @owner, @commissionDate, @location, 1, @now, @now)
      ON CONFLICT(name) DO UPDATE SET
        ip = excluded.ip,
        ssh_host = excluded.ssh_host,
        ssh_port = excluded.ssh_port,
        platform = excluded.platform,
        owner = excluded.owner,
        commission_date = excluded.commission_date,
        location = excluded.location,
        active = 1,
        updated_at = excluded.updated_at
    `).run({
      name: machine.name,
      ip: machine.ip,
      sshHost: machine.sshHost ?? machine.ip,
      sshPort: machine.sshPort ?? 22,
      platform: machine.platform ?? "",
      owner: machine.owner ?? "",
      commissionDate: machine.commissionDate ?? "",
      location: machine.location ?? "",
      now,
    });
    return rowToMachine(db.prepare("SELECT * FROM machines WHERE name = ?").get(machine.name) as MachineRow);
  }

  function markMissingInactive(activeNames: string[]): void {
    if (activeNames.length === 0) {
      db.prepare("UPDATE machines SET active = 0, updated_at = ?").run(new Date().toISOString());
      return;
    }
    const placeholders = activeNames.map(() => "?").join(",");
    db.prepare(`UPDATE machines SET active = 0, updated_at = ? WHERE name NOT IN (${placeholders})`).run(new Date().toISOString(), ...activeNames);
  }

  function createPollRun(machineCount: number): number {
    const info = db.prepare(`
      INSERT INTO poll_runs (started_at, status, machine_count)
      VALUES (?, 'running', ?)
    `).run(new Date().toISOString(), machineCount);
    return Number(info.lastInsertRowid);
  }

  function insertProbeResult(pollRunId: number, machineId: number, result: ProbeResult): number {
    const checkedAt = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO probe_results (
        poll_run_id, machine_id, checked_at, status, ssh_ok, ssh_error, ssh_user, remote_host, uptime,
        nvidia_smi_rc, gpu_count, gpu_type, gpu_jobs, gpu_power_w, gpu_avg_temp_c, net_rx_bps, net_tx_bps, bus_off_suspected,
        bus_off_reason, kernel_hits, nvidia_smi_output, nvidia_smi_error, duration_ms
      )
      VALUES (
        @pollRunId, @machineId, @checkedAt, @status, @sshOk, @sshError, @sshUser, @remoteHost, @uptime,
        @nvidiaSmiRc, @gpuCount, @gpuType, @gpuJobs, @gpuPowerW, @gpuAvgTempC, @netRxBps, @netTxBps, @busOffSuspected,
        @busOffReason, @kernelHits, @nvidiaSmiOutput, @nvidiaSmiError, @durationMs
      )
    `).run({
      pollRunId,
      machineId,
      checkedAt,
      status: result.status,
      sshOk: result.sshOk ? 1 : 0,
      sshError: result.sshError ?? "",
      sshUser: result.sshUser ?? "",
      remoteHost: result.remoteHost ?? "",
      uptime: result.uptime ?? "",
      nvidiaSmiRc: result.nvidiaSmiRc ?? null,
      gpuCount: result.gpuCount ?? null,
      gpuType: result.gpuType ?? "",
      gpuJobs: result.gpuJobs ?? "",
      gpuPowerW: parseNullableNumber(result.gpuPowerW),
      gpuAvgTempC: parseNullableNumber(result.gpuAvgTempC),
      netRxBps: result.netRxBps ?? null,
      netTxBps: result.netTxBps ?? null,
      busOffSuspected: result.busOffSuspected ? 1 : 0,
      busOffReason: result.busOffReason ?? "",
      kernelHits: result.kernelHits ?? "",
      nvidiaSmiOutput: result.nvidiaSmiOutput ?? "",
      nvidiaSmiError: result.nvidiaSmiError ?? "",
      durationMs: result.durationMs ?? null,
    });
    const probeResultId = Number(info.lastInsertRowid);
    for (const process of result.processes ?? []) {
      insertProcessRow(db, pollRunId, machineId, probeResultId, checkedAt, process);
    }
    for (const metric of result.gpuMetrics ?? []) {
      insertMetricRow(db, pollRunId, machineId, probeResultId, checkedAt, metric);
    }
    syncGpuDownEvents(db, machineId, checkedAt, result);
    return probeResultId;
  }

  function finishPollRun(pollRunId: number, error = ""): void {
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
        SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded_count,
        SUM(CASE WHEN status = 'ssh_failed' THEN 1 ELSE 0 END) AS ssh_failed_count
      FROM probe_results
      WHERE poll_run_id = ?
    `).get(pollRunId) as { ok_count: number | null; degraded_count: number | null; ssh_failed_count: number | null };
    const run = db.prepare("SELECT started_at FROM poll_runs WHERE id = ?").get(pollRunId) as { started_at: string };
    db.prepare(`
      UPDATE poll_runs
      SET finished_at = ?, status = ?, ok_count = ?, degraded_count = ?, ssh_failed_count = ?, duration_ms = ?, error = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      error ? "failed" : "complete",
      counts.ok_count ?? 0,
      counts.degraded_count ?? 0,
      counts.ssh_failed_count ?? 0,
      Date.now() - Date.parse(run.started_at),
      error,
      pollRunId,
    );
  }

  function listMachines(): MachineWithLatest[] {
    const rows = db.prepare(`
      SELECT m.*, pr.id AS latest_id, pr.checked_at, pr.status, pr.ssh_ok, pr.ssh_error, pr.ssh_user, pr.remote_host,
             pr.uptime, pr.nvidia_smi_rc, pr.gpu_count, pr.gpu_type, pr.gpu_jobs, pr.gpu_power_w,
             pr.gpu_avg_temp_c, pr.net_rx_bps, pr.net_tx_bps, pr.bus_off_suspected, pr.bus_off_reason, pr.duration_ms
      FROM machines m
      LEFT JOIN probe_results pr ON pr.id = (
        SELECT id FROM probe_results latest
        WHERE latest.machine_id = m.id
        ORDER BY latest.checked_at DESC
        LIMIT 1
      )
      WHERE m.active = 1
      ORDER BY m.name
    `).all() as LatestMachineRow[];
    return rows.map((row) => rowToMachineWithLatest(row, db));
  }

  function getMachine(id: number): MachineWithLatest | undefined {
    return listMachines().find((machine) => machine.id === id);
  }

  function listHistory(machineId: number, limit = 200, since?: string): ProbeResult[] {
    const rows = since
      ? db.prepare("SELECT * FROM probe_results WHERE machine_id = ? AND checked_at >= ? ORDER BY checked_at DESC LIMIT ?").all(machineId, since, limit) as ProbeRow[]
      : db.prepare("SELECT * FROM probe_results WHERE machine_id = ? ORDER BY checked_at DESC LIMIT ?").all(machineId, limit) as ProbeRow[];
    return rows.map((row) => enrichProbeResult(db, rowToProbeResult(row)));
  }

  function listProcesses(machineId: number, limit = 200): GpuProcess[] {
    const rows = db.prepare("SELECT * FROM gpu_processes WHERE machine_id = ? ORDER BY checked_at DESC, gpu_index ASC LIMIT ?").all(machineId, limit) as ProcessRow[];
    return rows.map(rowToProcess);
  }

  function listMetrics(machineId: number, limit = 200): GpuMetric[] {
    const rows = db.prepare("SELECT * FROM gpu_metrics WHERE machine_id = ? ORDER BY checked_at DESC, gpu_index ASC LIMIT ?").all(machineId, limit) as MetricRow[];
    return rows.map(rowToMetric);
  }

  function listPollRuns(limit = 50): PollRun[] {
    const rows = db.prepare("SELECT * FROM poll_runs ORDER BY started_at DESC LIMIT ?").all(limit) as PollRunRow[];
    return rows.map(rowToPollRun);
  }

  function getSummary(): Summary {
    const machines = listMachines();
    const latest = machines.map((machine) => machine.latest).filter(Boolean) as ProbeResult[];
    const totalPowerW = latest.reduce((sum, result) => sum + (Number(result.gpuPowerW) || 0), 0);
    const temps = latest.map((result) => Number(result.gpuAvgTempC)).filter(Number.isFinite);
    return {
      total: machines.length,
      ok: latest.filter((result) => result.status === "ok").length,
      degraded: latest.filter((result) => result.status === "degraded").length,
      sshFailed: latest.filter((result) => result.status === "ssh_failed").length,
      totalPowerW: Number(totalPowerW.toFixed(1)),
      averageTempC: temps.length > 0 ? Number((temps.reduce((sum, value) => sum + value, 0) / temps.length).toFixed(1)) : null,
      lastRun: listPollRuns(1)[0],
    };
  }

  function setMachineMaintenance(machineId: number, maintenance: boolean): Machine | undefined {
    db.prepare("UPDATE machines SET maintenance = ?, updated_at = ? WHERE id = ?").run(maintenance ? 1 : 0, new Date().toISOString(), machineId);
    const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as MachineRow | undefined;
    return row ? rowToMachine(row) : undefined;
  }

  function setExpectedGpuCount(machineId: number, expected: number | null): void {
    db.prepare("UPDATE machines SET expected_gpu_count = ?, updated_at = ? WHERE id = ?").run(expected, new Date().toISOString(), machineId);
  }

  function raiseExpectedGpuCount(machineId: number, gpuCount: number): void {
    db.prepare(`
      UPDATE machines SET expected_gpu_count = ?, updated_at = ?
      WHERE id = ? AND (expected_gpu_count IS NULL OR expected_gpu_count < ?)
    `).run(gpuCount, new Date().toISOString(), machineId, gpuCount);
  }

  function listFleetHistory(since: string, limit = 2000): FleetHistoryPoint[] {
    const rows = db.prepare(`
      SELECT p.id, p.started_at, p.ok_count, p.degraded_count, p.ssh_failed_count,
             (SELECT SUM(r.gpu_power_w) FROM probe_results r WHERE r.poll_run_id = p.id) AS total_power_w,
             (SELECT AVG(r.gpu_avg_temp_c) FROM probe_results r WHERE r.poll_run_id = p.id) AS avg_temp_c
      FROM poll_runs p
      WHERE p.status = 'complete' AND p.started_at >= ?
      ORDER BY p.started_at ASC
      LIMIT ?
    `).all(since, limit) as Array<{
      id: number;
      started_at: string;
      ok_count: number;
      degraded_count: number;
      ssh_failed_count: number;
      total_power_w: number | null;
      avg_temp_c: number | null;
    }>;
    return rows.map((row) => ({
      pollRunId: row.id,
      startedAt: row.started_at,
      okCount: row.ok_count,
      degradedCount: row.degraded_count,
      sshFailedCount: row.ssh_failed_count,
      totalPowerW: row.total_power_w === null ? null : Number(row.total_power_w.toFixed(1)),
      averageTempC: row.avg_temp_c === null ? null : Number(row.avg_temp_c.toFixed(1)),
    }));
  }

  function listGroupHistory(groupBy: "owner" | "location", key: string, since: string, limit = 2000): GroupHistoryPoint[] {
    const column = groupBy === "owner" ? "owner" : "location";
    // Labels in the UI come from buildMachineGroups, which trims CSV values.
    const rows = db.prepare(`
      SELECT p.id, p.started_at,
             COUNT(r.id) AS machine_count,
             SUM(r.gpu_power_w) AS total_power_w,
             AVG(r.gpu_avg_temp_c) AS avg_temp_c,
             SUM(r.net_rx_bps) AS net_rx_bps,
             SUM(r.net_tx_bps) AS net_tx_bps,
             (SELECT AVG(g.gpu_util) FROM gpu_metrics g
                JOIN machines gm ON gm.id = g.machine_id
              WHERE g.poll_run_id = p.id AND TRIM(gm.${column}) = @key) AS avg_gpu_util
      FROM poll_runs p
      JOIN probe_results r ON r.poll_run_id = p.id
      JOIN machines m ON m.id = r.machine_id
      WHERE p.status = 'complete' AND p.started_at >= @since AND TRIM(m.${column}) = @key
      GROUP BY p.id
      ORDER BY p.started_at ASC
      LIMIT @limit
    `).all({ key, since, limit }) as Array<{
      id: number;
      started_at: string;
      machine_count: number;
      total_power_w: number | null;
      avg_temp_c: number | null;
      net_rx_bps: number | null;
      net_tx_bps: number | null;
      avg_gpu_util: number | null;
    }>;
    const round = (value: number | null, digits = 1) => (value === null ? null : Number(value.toFixed(digits)));
    return rows.map((row) => ({
      pollRunId: row.id,
      startedAt: row.started_at,
      machineCount: row.machine_count,
      totalPowerW: round(row.total_power_w),
      averageTempC: round(row.avg_temp_c),
      averageGpuUtil: round(row.avg_gpu_util),
      netRxBps: round(row.net_rx_bps, 0),
      netTxBps: round(row.net_tx_bps, 0),
    }));
  }

  function getAlertStates(): Record<string, string> {
    const rows = db.prepare("SELECT machine_name, status FROM alert_states").all() as Array<{ machine_name: string; status: string }>;
    return Object.fromEntries(rows.map((row) => [row.machine_name, row.status]));
  }

  function saveAlertStates(states: Record<string, string>): void {
    const now = new Date().toISOString();
    const replaceAll = db.transaction((entries: Array<[string, string]>) => {
      db.prepare("DELETE FROM alert_states").run();
      const insert = db.prepare("INSERT INTO alert_states (machine_name, status, updated_at) VALUES (?, ?, ?)");
      for (const [name, status] of entries) {
        insert.run(name, status, now);
      }
    });
    replaceAll(Object.entries(states));
  }

  function pruneHistory(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return 0;
    }
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const prune = db.transaction((cutoffIso: string): number => {
      let deleted = 0;
      // Each machine's most recent probe row survives regardless of age, so a
      // long-unreachable machine keeps showing its last known state instead of
      // reverting to "unknown".
      const keepLatest = "SELECT MAX(id) FROM probe_results GROUP BY machine_id";
      deleted += db.prepare(`DELETE FROM gpu_processes WHERE checked_at < ? AND probe_result_id NOT IN (${keepLatest})`).run(cutoffIso).changes;
      deleted += db.prepare(`DELETE FROM gpu_metrics WHERE checked_at < ? AND probe_result_id NOT IN (${keepLatest})`).run(cutoffIso).changes;
      deleted += db.prepare(`DELETE FROM probe_results WHERE checked_at < ? AND id NOT IN (${keepLatest})`).run(cutoffIso).changes;
      deleted += db.prepare("DELETE FROM poll_runs WHERE started_at < ? AND id NOT IN (SELECT DISTINCT poll_run_id FROM probe_results)").run(cutoffIso).changes;
      deleted += db.prepare("DELETE FROM gpu_down_events WHERE recovered_at IS NOT NULL AND recovered_at < ?").run(cutoffIso).changes;
      return deleted;
    });
    return prune(cutoff);
  }

  function close(): void {
    db.close();
  }

  return {
    raw: db,
    migrate,
    upsertMachine,
    markMissingInactive,
    createPollRun,
    insertProbeResult,
    finishPollRun,
    listMachines,
    getMachine,
    listHistory,
    listProcesses,
    listMetrics,
    listPollRuns,
    getSummary,
    getAlertStates,
    saveAlertStates,
    setMachineMaintenance,
    setExpectedGpuCount,
    raiseExpectedGpuCount,
    listFleetHistory,
    listGroupHistory,
    pruneHistory,
    close,
  };
}

function insertMetricRow(db: Sqlite, pollRunId: number, machineId: number, probeResultId: number, checkedAt: string, metric: GpuMetric): void {
  db.prepare(`
    INSERT INTO gpu_metrics (
      probe_result_id, machine_id, poll_run_id, checked_at, gpu_index, pci_bus_id,
      gpu_util, mem_util, temp_c, power_w, power_limit_w, graphics_clock_mhz, memory_clock_mhz
    )
    VALUES (
      @probeResultId, @machineId, @pollRunId, @checkedAt, @gpuIndex, @pciBusId,
      @gpuUtil, @memUtil, @tempC, @powerW, @powerLimitW, @graphicsClockMhz, @memoryClockMhz
    )
  `).run({
    probeResultId,
    machineId,
    pollRunId,
    checkedAt,
    gpuIndex: metric.gpuIndex,
    pciBusId: metric.pciBusId ?? "",
    gpuUtil: metric.gpuUtil ?? null,
    memUtil: metric.memUtil ?? null,
    tempC: metric.tempC ?? null,
    powerW: metric.powerW ?? null,
    powerLimitW: metric.powerLimitW ?? null,
    graphicsClockMhz: metric.graphicsClockMhz ?? null,
    memoryClockMhz: metric.memoryClockMhz ?? null,
  });
}

function insertProcessRow(db: Sqlite, pollRunId: number, machineId: number, probeResultId: number, checkedAt: string, process: GpuProcess): void {
  db.prepare(`
    INSERT INTO gpu_processes (
      probe_result_id, machine_id, poll_run_id, checked_at, gpu_index, pid, process_type,
      sm_util, mem_util, enc_util, dec_util, command, user, elapsed, process_name, command_line
    )
    VALUES (
      @probeResultId, @machineId, @pollRunId, @checkedAt, @gpuIndex, @pid, @processType,
      @smUtil, @memUtil, @encUtil, @decUtil, @command, @user, @elapsed, @processName, @commandLine
    )
  `).run({
    probeResultId,
    machineId,
    pollRunId,
    checkedAt,
    gpuIndex: process.gpuIndex,
    pid: process.pid,
    processType: process.processType ?? "",
    smUtil: process.smUtil ?? null,
    memUtil: process.memUtil ?? null,
    encUtil: process.encUtil ?? null,
    decUtil: process.decUtil ?? null,
    command: process.command ?? "",
    user: process.user ?? "",
    elapsed: process.elapsed ?? "",
    processName: process.processName ?? "",
    commandLine: process.commandLine ?? "",
  });
}

function parseNullableNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ensureColumn(db: Sqlite, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

type MachineRow = {
  id: number;
  name: string;
  ip: string;
  ssh_host: string;
  ssh_port: number;
  platform: string;
  owner: string;
  commission_date: string;
  location: string;
  active: number;
  maintenance: number;
  expected_gpu_count: number | null;
  created_at: string;
  updated_at: string;
};

type LatestMachineRow = MachineRow & Partial<ProbeRow> & { latest_id: number | null };

type ProbeRow = {
  id: number;
  poll_run_id: number;
  machine_id: number;
  checked_at: string;
  status: ProbeResult["status"];
  ssh_ok: number;
  ssh_error: string;
  ssh_user: string;
  remote_host: string;
  uptime: string;
  nvidia_smi_rc: number | null;
  gpu_count: number | null;
  gpu_type: string;
  gpu_jobs: string;
  gpu_power_w: number | null;
  gpu_avg_temp_c: number | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  bus_off_suspected: number;
  bus_off_reason: string;
  kernel_hits: string;
  nvidia_smi_output: string;
  nvidia_smi_error: string;
  duration_ms: number | null;
};

type ProcessRow = {
  id: number;
  probe_result_id: number;
  machine_id: number;
  poll_run_id: number;
  checked_at: string;
  gpu_index: number;
  pid: number;
  process_type: string;
  sm_util: number | null;
  mem_util: number | null;
  enc_util: number | null;
  dec_util: number | null;
  command: string;
  user: string;
  elapsed: string;
  process_name: string;
  command_line: string;
};

type MetricRow = {
  id: number;
  probe_result_id: number;
  machine_id: number;
  poll_run_id: number;
  checked_at: string;
  gpu_index: number;
  pci_bus_id: string;
  gpu_util: number | null;
  mem_util: number | null;
  temp_c: number | null;
  power_w: number | null;
  power_limit_w: number | null;
  graphics_clock_mhz: number | null;
  memory_clock_mhz: number | null;
};

type GpuDownEventRow = {
  id: number;
  machine_id: number;
  gpu_index: number;
  down_since: string;
  recovered_at: string | null;
  created_at: string;
  updated_at: string;
};

type PollRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: PollRun["status"];
  machine_count: number;
  ok_count: number;
  degraded_count: number;
  ssh_failed_count: number;
  duration_ms: number | null;
  error: string;
};

function rowToMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    name: row.name,
    ip: row.ip,
    sshHost: row.ssh_host,
    sshPort: row.ssh_port,
    platform: row.platform,
    owner: row.owner,
    commissionDate: row.commission_date,
    location: row.location ?? "",
    active: row.active === 1,
    maintenance: row.maintenance === 1,
    expectedGpuCount: row.expected_gpu_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMachineWithLatest(row: LatestMachineRow, db: Sqlite): MachineWithLatest {
  const machine: MachineWithLatest = rowToMachine(row);
  machine.activeGpuNotes = listActiveGpuDownNotes(db, row.id);
  if (row.latest_id) {
    machine.latest = enrichProbeResult(db, rowToProbeResult({
      id: row.latest_id,
      poll_run_id: row.poll_run_id!,
      machine_id: row.id,
      checked_at: row.checked_at!,
      status: row.status!,
      ssh_ok: row.ssh_ok!,
      ssh_error: row.ssh_error ?? "",
      ssh_user: row.ssh_user ?? "",
      remote_host: row.remote_host ?? "",
      uptime: row.uptime ?? "",
      nvidia_smi_rc: row.nvidia_smi_rc ?? null,
      gpu_count: row.gpu_count ?? null,
      gpu_type: row.gpu_type ?? "",
      gpu_jobs: row.gpu_jobs ?? "",
      gpu_power_w: row.gpu_power_w ?? null,
      gpu_avg_temp_c: row.gpu_avg_temp_c ?? null,
      net_rx_bps: row.net_rx_bps ?? null,
      net_tx_bps: row.net_tx_bps ?? null,
      bus_off_suspected: row.bus_off_suspected ?? 0,
      bus_off_reason: row.bus_off_reason ?? "",
      kernel_hits: "",
      nvidia_smi_output: "",
      nvidia_smi_error: "",
      duration_ms: row.duration_ms ?? null,
    }));
  }
  return machine;
}

function syncGpuDownEvents(db: Sqlite, machineId: number, checkedAt: string, result: ProbeResult): void {
  if (!result.sshOk) {
    return;
  }
  const downGpuIndexes = gpuDownIndexes(result.gpuJobs ?? "");
  const activeRows = db.prepare("SELECT * FROM gpu_down_events WHERE machine_id = ? AND recovered_at IS NULL").all(machineId) as GpuDownEventRow[];
  const activeIndexes = new Set(activeRows.map((row) => row.gpu_index));

  for (const gpuIndex of downGpuIndexes) {
    if (activeIndexes.has(gpuIndex)) {
      db.prepare("UPDATE gpu_down_events SET updated_at = ? WHERE machine_id = ? AND gpu_index = ? AND recovered_at IS NULL").run(checkedAt, machineId, gpuIndex);
      continue;
    }
    db.prepare(`
      INSERT INTO gpu_down_events (machine_id, gpu_index, down_since, recovered_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(machineId, gpuIndex, checkedAt, checkedAt, checkedAt);
  }

  for (const row of activeRows) {
    if (downGpuIndexes.has(row.gpu_index)) {
      continue;
    }
    db.prepare("UPDATE gpu_down_events SET recovered_at = ?, updated_at = ? WHERE id = ?").run(checkedAt, checkedAt, row.id);
  }
}

function gpuDownIndexes(gpuJobs: string): Set<number> {
  const indexes = new Set<number>();
  [...gpuJobs].forEach((state, index) => {
    if (state === "E") {
      indexes.add(index);
    }
  });
  return indexes;
}

function listActiveGpuDownNotes(db: Sqlite, machineId: number): GpuDownNote[] {
  const rows = db.prepare(`
    SELECT * FROM gpu_down_events
    WHERE machine_id = ? AND recovered_at IS NULL
    ORDER BY gpu_index ASC
  `).all(machineId) as GpuDownEventRow[];
  return rows.map(rowToGpuDownNote);
}

function enrichProbeResult(db: Sqlite, result: ProbeResult): ProbeResult {
  if (!result.id) {
    return result;
  }
  result.processes = (db.prepare("SELECT * FROM gpu_processes WHERE probe_result_id = ? ORDER BY gpu_index ASC, pid ASC").all(result.id) as ProcessRow[]).map(rowToProcess);
  result.gpuMetrics = (db.prepare("SELECT * FROM gpu_metrics WHERE probe_result_id = ? ORDER BY gpu_index ASC").all(result.id) as MetricRow[]).map(rowToMetric);
  return result;
}

function rowToProbeResult(row: ProbeRow): ProbeResult {
  return {
    id: row.id,
    pollRunId: row.poll_run_id,
    machineId: row.machine_id,
    checkedAt: row.checked_at,
    name: "",
    ip: "",
    sshOk: row.ssh_ok === 1,
    sshError: row.ssh_error,
    sshUser: row.ssh_user,
    remoteHost: row.remote_host,
    uptime: row.uptime,
    nvidiaSmiRc: row.nvidia_smi_rc,
    gpuCount: row.gpu_count,
    gpuType: row.gpu_type,
    gpuJobs: row.gpu_jobs,
    gpuPowerW: row.gpu_power_w === null ? "" : row.gpu_power_w.toFixed(1),
    gpuAvgTempC: row.gpu_avg_temp_c === null ? "" : row.gpu_avg_temp_c.toFixed(1),
    netRxBps: row.net_rx_bps,
    netTxBps: row.net_tx_bps,
    busOffSuspected: row.bus_off_suspected === 1,
    busOffReason: row.bus_off_reason,
    kernelHits: row.kernel_hits,
    nvidiaSmiOutput: row.nvidia_smi_output,
    nvidiaSmiError: row.nvidia_smi_error,
    status: row.status,
    durationMs: row.duration_ms ?? undefined,
  };
}

function rowToProcess(row: ProcessRow): GpuProcess {
  return {
    id: row.id,
    probeResultId: row.probe_result_id,
    machineId: row.machine_id,
    pollRunId: row.poll_run_id,
    checkedAt: row.checked_at,
    gpuIndex: row.gpu_index,
    pid: row.pid,
    processType: row.process_type,
    smUtil: row.sm_util,
    memUtil: row.mem_util,
    encUtil: row.enc_util,
    decUtil: row.dec_util,
    command: row.command,
    user: row.user,
    elapsed: row.elapsed,
    processName: row.process_name,
    commandLine: row.command_line,
  };
}

function rowToMetric(row: MetricRow): GpuMetric {
  return {
    id: row.id,
    probeResultId: row.probe_result_id,
    machineId: row.machine_id,
    pollRunId: row.poll_run_id,
    checkedAt: row.checked_at,
    gpuIndex: row.gpu_index,
    pciBusId: row.pci_bus_id,
    gpuUtil: row.gpu_util,
    memUtil: row.mem_util,
    tempC: row.temp_c,
    powerW: row.power_w,
    powerLimitW: row.power_limit_w,
    graphicsClockMhz: row.graphics_clock_mhz,
    memoryClockMhz: row.memory_clock_mhz,
  };
}

function rowToGpuDownNote(row: GpuDownEventRow): GpuDownNote {
  return {
    id: row.id,
    machineId: row.machine_id,
    gpuIndex: row.gpu_index,
    downSince: row.down_since,
    recoveredAt: row.recovered_at ?? undefined,
    note: `GPU ${row.gpu_index} down since ${new Date(row.down_since).toLocaleString()}`,
  };
}

function rowToPollRun(row: PollRunRow): PollRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    status: row.status,
    machineCount: row.machine_count,
    okCount: row.ok_count,
    degradedCount: row.degraded_count,
    sshFailedCount: row.ssh_failed_count,
    durationMs: row.duration_ms ?? undefined,
    error: row.error,
  };
}
