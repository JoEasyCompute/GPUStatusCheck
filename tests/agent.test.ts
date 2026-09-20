import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDrainBatch, parseDrainOutput, type DrainOutput } from "../src/server/agent";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db";
import { PollScheduler } from "../src/server/scheduler";
import type { Machine, ProbeResult } from "../src/shared/types";

const UUID_A = "GPU-agent-aaaa-1111";
const UUID_B = "GPU-agent-bbbb-2222";

function sampleText(options: { gpuUtil?: number; powerW?: number; rc?: number; kernelLine?: string } = {}): string {
  const { gpuUtil = 50, powerW = 200, rc = 0, kernelLine } = options;
  return [
    "MACHINE_NAME=alpha",
    "REMOTE_HOST=alpha-local",
    "UPTIME_PRETTY=up 3 days",
    `NVIDIA_SMI_RC=${rc}`,
    "GPU_COUNT=2",
    "GPU_TYPE=NVIDIA GeForce RTX 4090",
    "GPU_JOBS=Dx",
    `GPU_POWER_W=${powerW * 2}`,
    "GPU_AVG_TEMP_C=55.0",
    "NET_RX_BPS=1000",
    "NET_TX_BPS=2000",
    "CPU_MODEL=AMD EPYC 7543",
    "CPU_CORES=64",
    "CPU_UTIL_PCT=12.5",
    "MEM_TOTAL_KB=131072000",
    "MEM_USED_PCT=40",
    "DISK_TOTAL_KB=102400000",
    "DISK_USED_PCT=33",
    "AGENT_VERSION=0.1.0",
    "BUS_OFF=0",
    "GPU_METRICS<<__GPUCHECK_EOF__",
    `0, 00000000:01:00.0, ${gpuUtil}, 10, 55, ${powerW}, 450, 2000, 10000, ${UUID_A}`,
    `1, 00000000:02:00.0, ${gpuUtil}, 10, 56, ${powerW}, 450, 2000, 10000, ${UUID_B}`,
    "__GPUCHECK_EOF__",
    "PMON_OUTPUT<<__GPUCHECK_EOF__",
    "0 777 C 50 10 0 0 python",
    "__GPUCHECK_EOF__",
    "PS_OUTPUT<<__GPUCHECK_EOF__",
    "777 tenant 01:00:00 python python miner.py",
    "__GPUCHECK_EOF__",
    "AGENT_KERNEL_EVENTS<<__GPUCHECK_EOF__",
    ...(kernelLine ? [kernelLine] : []),
    "__GPUCHECK_EOF__",
  ].join("\n");
}

function spoolLine(ts: string, options?: Parameters<typeof sampleText>[0]): string {
  return `${ts} ${Buffer.from(sampleText(options)).toString("base64")}`;
}

function drainStdout(lines: string[], options: { end?: boolean; spool?: boolean } = {}): string {
  const { end = true, spool = true } = options;
  return [
    "AGENT_DRAIN=1",
    `HOST_NOW=${new Date().toISOString().slice(0, 19)}Z`,
    `AGENT_SPOOL=${spool ? "present" : "absent"}`,
    ...(spool ? ["AGENT_VERSION=0.1.0", "AGENT_LINES_BEGIN", ...lines, ...(end ? ["AGENT_LINES_END"] : [])] : []),
  ].join("\n");
}

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "gpu-agent-"));
  const db = createDatabase(join(dir, "test.sqlite"));
  db.migrate();
  const machine = db.upsertMachine({ name: "alpha", ip: "10.0.0.1", sshHost: "10.0.0.1", sshPort: 22, owner: "iota" });
  return { dir, db, machine };
}

describe("parseDrainOutput", () => {
  it("parses framed lines and metadata", () => {
    const ts = "2026-07-24T10:00:00Z";
    const output = parseDrainOutput(drainStdout([spoolLine(ts)]));

    expect(output.spoolPresent).toBe(true);
    expect(output.agentVersion).toBe("0.1.0");
    expect(output.complete).toBe(true);
    expect(output.lines).toHaveLength(1);
    expect(output.lines[0].ts).toBe(ts);
  });

  it("marks output incomplete when END is missing so the batch is discarded", () => {
    const output = parseDrainOutput(drainStdout([spoolLine("2026-07-24T10:00:00Z")], { end: false }));

    expect(output.complete).toBe(false);
  });

  it("counts torn or malformed lines without aborting the batch", () => {
    const output = parseDrainOutput(drainStdout([
      spoolLine("2026-07-24T10:00:00Z"),
      "not-a-timestamp garbage",
      "2026-07-24T10:01:00Z",
    ]));

    expect(output.lines).toHaveLength(1);
    expect(output.malformedLines).toBe(2);
  });

  it("treats an absent spool as complete and empty", () => {
    const output = parseDrainOutput(drainStdout([], { spool: false }));

    expect(output.spoolPresent).toBe(false);
    expect(output.complete).toBe(true);
    expect(output.lines).toHaveLength(0);
  });
});

describe("ingestDrainBatch", () => {
  it("preserves historical timestamps and never touches identity or drop tables", () => {
    const { db, machine } = makeDb();
    const before = {
      gpus: db.raw.prepare("SELECT COUNT(*) AS n FROM gpus").get(),
      sightings: db.raw.prepare("SELECT COUNT(*) AS n FROM gpu_sightings").get(),
      downEvents: db.raw.prepare("SELECT COUNT(*) AS n FROM gpu_down_events").get(),
      incidents: db.raw.prepare("SELECT COUNT(*) AS n FROM gpu_drop_incidents").get(),
    };

    const ts = "2026-07-20T03:04:05Z";
    const output = parseDrainOutput(drainStdout([spoolLine(ts, { kernelLine: "2026-07-20T03:03:59.000000+00:00 alpha kernel: NVRM: Xid 79" })]));
    const result = ingestDrainBatch(db, machine, output, 512);

    expect(result.ingested).toBe(1);
    expect(result.kernelEvents).toBe(1);
    expect(result.watermark).toBe(ts);

    const row = db.raw.prepare("SELECT checked_at, source, status, gpu_count FROM probe_results WHERE machine_id = ?").get(machine.id) as {
      checked_at: string; source: string; status: string; gpu_count: number;
    };
    expect(row.checked_at).toBe(ts);
    expect(row.source).toBe("agent");
    expect(row.status).toBe("ok");
    const metrics = db.raw.prepare("SELECT COUNT(*) AS n FROM gpu_metrics WHERE machine_id = ? AND checked_at = ?").get(machine.id, ts) as { n: number };
    expect(metrics.n).toBe(2);

    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM gpus").get()).toEqual(before.gpus);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM gpu_sightings").get()).toEqual(before.sightings);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM gpu_down_events").get()).toEqual(before.downEvents);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM gpu_drop_incidents").get()).toEqual(before.incidents);

    const run = db.raw.prepare("SELECT status FROM poll_runs ORDER BY id DESC LIMIT 1").get() as { status: string };
    expect(run.status).toBe("agent");
    expect(db.listPollRuns()).toHaveLength(0);
  });

  it("is idempotent under re-drains and rejects future timestamps", () => {
    const { db, machine } = makeDb();
    const ts = "2026-07-20T03:04:05Z";
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 19) + "Z";
    const output = parseDrainOutput(drainStdout([spoolLine(ts), spoolLine(future)]));

    const first = ingestDrainBatch(db, machine, output, 512);
    expect(first.ingested).toBe(1);
    expect(first.skipped).toBe(1);

    const second = ingestDrainBatch(db, machine, output, 512);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(1);

    const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM probe_results WHERE machine_id = ? AND source = 'agent'").get(machine.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("recomputes daily rollups when backfill lands below the watermark", () => {
    const { db, machine } = makeDb();
    // Establish a rollup watermark at yesterday via a live-poll metric.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const day = yesterday.slice(0, 10);
    const runId = db.createPollRun(1);
    db.insertProbeResult(runId, machine.id!, {
      name: "alpha", ip: "10.0.0.1", sshOk: true, status: "ok", gpuCount: 2, gpuJobs: "xx",
      gpuMetrics: [{ gpuIndex: 0, uuid: UUID_A, gpuUtil: 100, powerW: 400 }],
    });
    db.finishPollRun(runId);
    db.raw.prepare("UPDATE gpu_metrics SET checked_at = ? WHERE machine_id = ?").run(yesterday, machine.id);
    expect(db.rollupGpuDailyStats()).toBeGreaterThan(0);
    const rolled = db.raw.prepare("SELECT sample_count FROM gpu_daily_stats WHERE uuid = ? AND day = ?").get(UUID_A, day) as { sample_count: number };
    expect(rolled.sample_count).toBe(1);

    // Backfill an agent sample into that already-finalized day.
    const backfillTs = `${day}T12:00:00Z`;
    const output = parseDrainOutput(drainStdout([spoolLine(backfillTs, { gpuUtil: 0, powerW: 100 })]));
    const result = ingestDrainBatch(db, machine, output, 512);
    expect(result.ingested).toBe(1);

    const recomputed = db.raw.prepare("SELECT sample_count FROM gpu_daily_stats WHERE uuid = ? AND day = ?").get(UUID_A, day) as { sample_count: number };
    expect(recomputed.sample_count).toBe(2);
  });

  it("deduplicates kernel events across overlapping drains", () => {
    const { db, machine } = makeDb();
    const kernelLine = "2026-07-20T03:03:59.000000+00:00 alpha kernel: NVRM: Xid 79";
    const output1 = parseDrainOutput(drainStdout([spoolLine("2026-07-20T03:04:05Z", { kernelLine })]));
    const output2 = parseDrainOutput(drainStdout([spoolLine("2026-07-20T03:05:05Z", { kernelLine })]));

    expect(ingestDrainBatch(db, machine, output1, 512).kernelEvents).toBe(1);
    expect(ingestDrainBatch(db, machine, output2, 512).kernelEvents).toBe(0);
    expect(db.listKernelEvents(machine.id!)).toHaveLength(1);
  });
});

describe("late-data safety in shared tables", () => {
  it("keeps the live probe row as machine latest even when agent rows are newer", () => {
    const { db, machine } = makeDb();
    const runId = db.createPollRun(1);
    db.insertProbeResult(runId, machine.id!, {
      name: "alpha", ip: "10.0.0.1", sshOk: true, status: "degraded", gpuCount: 2, gpuJobs: "Ex",
    });
    db.finishPollRun(runId);

    const newer = new Date(Date.now() + 60 * 1000).toISOString().slice(0, 19) + "Z";
    // within skew tolerance so it ingests
    const output = parseDrainOutput(drainStdout([spoolLine(newer)]));
    expect(ingestDrainBatch(db, machine, output, 512).ingested).toBe(1);

    const latest = db.listMachines()[0]?.latest;
    expect(latest?.source).toBe("probe");
    expect(latest?.status).toBe("degraded");
  });

  it("prunes agent rows on their own retention while probe keep-latest survives backfill", () => {
    const { db, machine } = makeDb();
    const runId = db.createPollRun(1);
    db.insertProbeResult(runId, machine.id!, {
      name: "alpha", ip: "10.0.0.1", sshOk: true, status: "ok", gpuCount: 2, gpuJobs: "xx",
    });
    db.finishPollRun(runId);
    // Age the probe row far past retention; it must survive as keep-latest.
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.raw.prepare("UPDATE probe_results SET checked_at = ? WHERE machine_id = ?").run(old, machine.id);

    // Agent backfill with a HIGHER rowid but also ancient timestamp: must be
    // pruned by the agent cutoff and must NOT displace keep-latest.
    const agentTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19) + "Z";
    const output = parseDrainOutput(drainStdout([spoolLine(agentTs)]));
    expect(ingestDrainBatch(db, machine, output, 512).ingested).toBe(1);

    db.pruneHistory(90, 21);
    const remaining = db.raw.prepare("SELECT source, checked_at FROM probe_results WHERE machine_id = ?").all(machine.id) as Array<{ source: string; checked_at: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source).toBe("probe");
    expect(db.listMachines()[0]?.latest?.status).toBe("ok");
  });
});

describe("scheduler drain wiring", () => {
  function makeScheduler(options: { agentVersion: string; drainStdout: string; drainEnabled?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "gpu-agent-sched-"));
    const csvPath = join(dir, "machines.csv");
    writeFileSync(csvPath, "name,ip,owner\nalpha,10.0.0.1,iota\n");
    const db = createDatabase(join(dir, "db.sqlite"));
    db.migrate();
    const config: AppConfig = {
      machinesPath: csvPath, dbPath: join(dir, "db.sqlite"), envPath: join(dir, ".env"),
      user: "ezc", fallbackUser: "", keyPath: "~/.ssh/test",
      connectTimeoutSeconds: 10, probeTimeoutSeconds: 60, jobs: 1, pollIntervalSeconds: 300,
      skipLogs: true, processArgsMaxChars: 512, pollOnStartup: false, retentionDays: 30, minFreeDiskBytes: 5 * 1024 ** 3,
      telegramBotToken: "", telegramChatId: "",
      slackBotToken: "", slackChannelsPath: "", slackDryRun: false,
      agentDrainEnabled: options.drainEnabled ?? true, agentDrainTimeoutSeconds: 120, agentDrainMaxLines: 600, agentRetentionDays: 21,
      notifyRecovery: false, heartbeatUrl: "", host: "127.0.0.1", port: 0,
    };
    const drains: string[] = [];
    const probeMachine = async (machine: Machine): Promise<ProbeResult> => ({
      name: machine.name, ip: machine.ip, owner: "iota", sshOk: true, status: "ok",
      gpuCount: 2, gpuType: "4090", gpuJobs: "xx", agentVersion: options.agentVersion,
      gpuMetrics: [{ gpuIndex: 0, uuid: UUID_A }, { gpuIndex: 1, uuid: UUID_B }],
    });
    const scheduler = new PollScheduler(
      db, config, probeMachine,
      async () => {}, async () => "ts",
      async (_machine, watermark) => {
        drains.push(watermark);
        return { code: 0, stdout: options.drainStdout, stderr: "" };
      },
    );
    return { db, scheduler, drains };
  }

  it("drains only agent hosts, ingests, and advances the watermark", async () => {
    const ts = "2026-07-24T10:00:00Z";
    const harness = makeScheduler({ agentVersion: "0.1.0", drainStdout: drainStdout([spoolLine(ts)]) });

    await harness.scheduler.pollOnce();
    expect(harness.drains).toEqual([""]);
    const machineId = harness.db.listMachines()[0].id!;
    expect(harness.db.getAgentState(machineId)?.lastIngestedAt).toBe(ts);
    expect(harness.db.getAgentState(machineId)?.agentVersion).toBe("0.1.0");

    await harness.scheduler.pollOnce();
    expect(harness.drains).toEqual(["", ts]);
  });

  it("never drains hosts without the agent", async () => {
    const harness = makeScheduler({ agentVersion: "", drainStdout: drainStdout([]) });

    await harness.scheduler.pollOnce();
    expect(harness.drains).toEqual([]);
  });

  it("discards truncated batches without advancing the watermark", async () => {
    const ts = "2026-07-24T10:00:00Z";
    const harness = makeScheduler({
      agentVersion: "0.1.0",
      drainStdout: drainStdout([spoolLine(ts)], { end: false }),
    });

    await harness.scheduler.pollOnce();
    const machineId = harness.db.listMachines()[0].id!;
    expect(harness.db.getAgentState(machineId)?.lastIngestedAt ?? "").toBe("");
    expect(harness.db.getAgentState(machineId)?.lastError).toContain("truncated");
    const rows = harness.db.raw.prepare("SELECT COUNT(*) AS n FROM probe_results WHERE source = 'agent'").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
