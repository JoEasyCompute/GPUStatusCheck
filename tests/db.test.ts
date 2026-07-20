import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/server/db";

describe("database", () => {
  it("stores machines, probe history, processes, and summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-db-"));
    const db = createDatabase(join(dir, "test.sqlite"));
    db.migrate();

    const machine = db.upsertMachine({
      name: "alpha",
      ip: "10.0.0.1:2222",
      sshHost: "10.0.0.1",
      sshPort: 2222,
      platform: "gc",
      owner: "ops",
      commissionDate: "2026-01-01",
    });
    const runId = db.createPollRun(1);
    const resultId = db.insertProbeResult(runId, machine.id!, {
      name: "alpha",
      ip: "10.0.0.1:2222",
      sshOk: true,
      status: "ok",
      gpuCount: 8,
      gpuType: "NVIDIA GeForce RTX 4090",
      gpuJobs: "Dxxxxxxx",
      gpuPowerW: "512.3",
      gpuAvgTempC: "61.5",
      cpuModel: "AMD EPYC 7543 32-Core Processor",
      cpuCores: 128,
      cpuUtilPct: 42.7,
      memTotalKb: 527884568,
      memUsedPct: 31.4,
      diskTotalKb: 1843200000,
      diskUsedPct: 67,
      processes: [
        {
          gpuIndex: 0,
          pid: 1234,
          command: "python",
          user: "ops",
          elapsed: "01:02:03",
          processName: "python",
          commandLine: "python train.py",
        },
      ],
      gpuMetrics: [
        {
          gpuIndex: 0,
          pciBusId: "00000000:65:00.0",
          gpuUtil: 91,
          memUtil: 42,
          tempC: 67,
          powerW: 312.5,
          powerLimitW: 450,
          graphicsClockMhz: 2520,
          memoryClockMhz: 10501,
        },
        {
          gpuIndex: 1,
          pciBusId: "00000000:B3:00.0",
          gpuUtil: 0,
          memUtil: 0,
          tempC: 51,
          powerW: 48.2,
          powerLimitW: 450,
          graphicsClockMhz: 210,
          memoryClockMhz: 405,
        },
      ],
    });
    db.finishPollRun(runId);

    expect(resultId).toBeGreaterThan(0);
    expect(db.listMachines()[0]?.latest?.gpuType).toBe("NVIDIA GeForce RTX 4090");
    expect(db.listMachines()[0]?.latest?.gpuJobs).toBe("Dxxxxxxx");
    expect(db.listMachines()[0]?.latest).toMatchObject({
      cpuModel: "AMD EPYC 7543 32-Core Processor",
      cpuCores: 128,
      cpuUtilPct: 42.7,
      memTotalKb: 527884568,
      memUsedPct: 31.4,
      diskTotalKb: 1843200000,
      diskUsedPct: 67,
    });
    expect(db.listHistory(machine.id!)[0]).toMatchObject({ cpuUtilPct: 42.7, memUsedPct: 31.4, diskUsedPct: 67 });
    expect(db.listMachines()[0]?.latest?.processes?.[0]).toMatchObject({
      pid: 1234,
      commandLine: "python train.py",
    });
    expect(db.listMachines()[0]?.latest?.gpuMetrics).toEqual([
      expect.objectContaining({ gpuIndex: 0, pciBusId: "00000000:65:00.0", gpuUtil: 91, memUtil: 42, tempC: 67, powerW: 312.5, powerLimitW: 450, graphicsClockMhz: 2520, memoryClockMhz: 10501 }),
      expect.objectContaining({ gpuIndex: 1, pciBusId: "00000000:B3:00.0", gpuUtil: 0, memUtil: 0, tempC: 51, powerW: 48.2, powerLimitW: 450, graphicsClockMhz: 210, memoryClockMhz: 405 }),
    ]);
    expect(db.getSummary()).toMatchObject({
      total: 1,
      ok: 1,
      degraded: 0,
      sshFailed: 0,
      totalPowerW: 512.3,
      averageTempC: 61.5,
    });
    expect(db.listProcesses(machine.id!)[0]).toMatchObject({
      pid: 1234,
      commandLine: "python train.py",
    });

    db.close();
  });

  it("prunes history older than retention but keeps each machine's latest probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-db-prune-"));
    const db = createDatabase(join(dir, "test.sqlite"));
    db.migrate();

    const machine = db.upsertMachine({
      name: "alpha",
      ip: "10.0.0.1",
      sshHost: "10.0.0.1",
      sshPort: 22,
    });
    const probe = {
      name: "alpha",
      ip: "10.0.0.1",
      sshOk: true,
      status: "ok" as const,
      gpuCount: 1,
      gpuJobs: "D",
      processes: [{ gpuIndex: 0, pid: 1, commandLine: "python train.py" }],
      gpuMetrics: [{ gpuIndex: 0, powerW: 100 }],
    };

    const oldRun = db.createPollRun(1);
    db.insertProbeResult(oldRun, machine.id!, probe);
    db.finishPollRun(oldRun);
    const newRun = db.createPollRun(1);
    db.insertProbeResult(newRun, machine.id!, probe);
    db.finishPollRun(newRun);

    const backdate = (runId: number, iso: string) => {
      db.raw.prepare("UPDATE probe_results SET checked_at = ? WHERE poll_run_id = ?").run(iso, runId);
      db.raw.prepare("UPDATE gpu_processes SET checked_at = ? WHERE poll_run_id = ?").run(iso, runId);
      db.raw.prepare("UPDATE gpu_metrics SET checked_at = ? WHERE poll_run_id = ?").run(iso, runId);
      db.raw.prepare("UPDATE poll_runs SET started_at = ? WHERE id = ?").run(iso, runId);
    };
    const staleIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    backdate(oldRun, staleIso);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(db.listHistory(machine.id!, 200)).toHaveLength(2);
    expect(db.listHistory(machine.id!, 200, since)).toHaveLength(1);

    expect(db.pruneHistory(30)).toBeGreaterThan(0);
    expect(db.listHistory(machine.id!)).toHaveLength(1);
    expect(db.listPollRuns()).toHaveLength(1);
    expect(db.pruneHistory(0)).toBe(0);

    // Even when every probe is stale, the machine's latest row survives.
    backdate(newRun, staleIso);
    db.pruneHistory(30);
    expect(db.listHistory(machine.id!)).toHaveLength(1);
    expect(db.listMachines()[0]?.latest?.status).toBe("ok");
    expect(db.listMachines()[0]?.latest?.gpuMetrics).toHaveLength(1);

    db.close();
  });

  it("aggregates per-group history by owner and location", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-db-group-"));
    const db = createDatabase(join(dir, "test.sqlite"));
    db.migrate();

    const alpha = db.upsertMachine({ name: "alpha", ip: "10.0.0.1", sshHost: "10.0.0.1", sshPort: 22, owner: "iota", location: "Shed1" });
    const beta = db.upsertMachine({ name: "beta", ip: "10.0.0.2", sshHost: "10.0.0.2", sshPort: 22, owner: "iota", location: "Shed2" });
    const gamma = db.upsertMachine({ name: "gamma", ip: "10.0.0.3", sshHost: "10.0.0.3", sshPort: 22, owner: "mining", location: "Shed1" });

    const runId = db.createPollRun(3);
    db.insertProbeResult(runId, alpha.id!, {
      name: "alpha", ip: "10.0.0.1", sshOk: true, status: "ok", gpuCount: 2, gpuJobs: "DD",
      gpuPowerW: "400", gpuAvgTempC: "60", netRxBps: 1000, netTxBps: 2000,
      gpuMetrics: [{ gpuIndex: 0, gpuUtil: 90 }, { gpuIndex: 1, gpuUtil: 70 }],
    });
    db.insertProbeResult(runId, beta.id!, {
      name: "beta", ip: "10.0.0.2", sshOk: true, status: "ok", gpuCount: 1, gpuJobs: "D",
      gpuPowerW: "100", gpuAvgTempC: "40", netRxBps: 500, netTxBps: 500,
      gpuMetrics: [{ gpuIndex: 0, gpuUtil: 20 }],
    });
    db.insertProbeResult(runId, gamma.id!, {
      name: "gamma", ip: "10.0.0.3", sshOk: true, status: "ok", gpuCount: 1, gpuJobs: "D",
      gpuPowerW: "999", gpuAvgTempC: "99", netRxBps: 9999, netTxBps: 9999,
      gpuMetrics: [{ gpuIndex: 0, gpuUtil: 100 }],
    });
    db.finishPollRun(runId);

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const iota = db.listGroupHistory("owner", "iota", since);
    expect(iota).toHaveLength(1);
    expect(iota[0]).toMatchObject({
      pollRunId: runId,
      machineCount: 2,
      totalPowerW: 500,
      averageTempC: 50,
      averageGpuUtil: 60,
      netRxBps: 1500,
      netTxBps: 2500,
    });

    const shed1 = db.listGroupHistory("location", "Shed1", since);
    expect(shed1).toHaveLength(1);
    expect(shed1[0]).toMatchObject({ machineCount: 2, totalPowerW: 1399, averageTempC: 79.5, averageGpuUtil: 86.7 });

    expect(db.listGroupHistory("owner", "nobody", since)).toHaveLength(0);

    db.close();
  });

  it("tracks a GPU by uuid across machines with sighting segments and owner-stamped jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-db-uuid-"));
    const db = createDatabase(join(dir, "test.sqlite"));
    db.migrate();

    const uuid = "GPU-aaaa1111-2222-3333-4444-555566667777";
    const alpha = db.upsertMachine({ name: "alpha", ip: "10.0.0.1", sshHost: "10.0.0.1", sshPort: 22, owner: "iota" });
    const beta = db.upsertMachine({ name: "beta", ip: "10.0.0.2", sshHost: "10.0.0.2", sshPort: 22, owner: "mining" });

    // Card first lives in alpha (tenant iota), running a job.
    const run1 = db.createPollRun(2);
    db.insertProbeResult(run1, alpha.id!, {
      name: "alpha", ip: "10.0.0.1", owner: "iota", sshOk: true, status: "ok",
      gpuCount: 1, gpuType: "4090", gpuJobs: "D",
      gpuMetrics: [{ gpuIndex: 0, uuid, gpuUtil: 95, powerW: 300 }],
      processes: [{ gpuIndex: 0, pid: 42, commandLine: "python train.py" }],
    });
    db.finishPollRun(run1);

    // Same slot next poll: the sighting segment extends instead of duplicating.
    const run2 = db.createPollRun(2);
    db.insertProbeResult(run2, alpha.id!, {
      name: "alpha", ip: "10.0.0.1", owner: "iota", sshOk: true, status: "ok",
      gpuCount: 1, gpuType: "4090", gpuJobs: "x",
      gpuMetrics: [{ gpuIndex: 0, uuid, gpuUtil: 0, powerW: 20 }],
    });
    db.finishPollRun(run2);

    // Card is reseated into beta slot 3 under another tenant.
    const run3 = db.createPollRun(2);
    db.insertProbeResult(run3, beta.id!, {
      name: "beta", ip: "10.0.0.2", owner: "mining", sshOk: true, status: "ok",
      gpuCount: 4, gpuType: "4090", gpuJobs: "xxxD",
      gpuMetrics: [{ gpuIndex: 3, uuid, gpuUtil: 50, powerW: 250 }],
    });
    db.finishPollRun(run3);

    const gpus = db.listGpus();
    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({
      uuid,
      gpuType: "4090",
      lastMachineId: beta.id,
      lastMachineName: "beta",
      lastGpuIndex: 3,
      lastOwner: "mining",
      sightingCount: 2,
    });

    const detail = db.getGpu(uuid)!;
    expect(detail.sightings).toHaveLength(2);
    expect(detail.sightings[0]).toMatchObject({ machineName: "beta", gpuIndex: 3, owner: "mining" });
    expect(detail.sightings[1]).toMatchObject({ machineName: "alpha", gpuIndex: 0, owner: "iota" });
    expect(detail.sightings[1].firstSeenAt <= detail.sightings[1].lastSeenAt).toBe(true);
    // The card's metric history spans both machines.
    expect(detail.metrics).toHaveLength(3);
    expect(new Set(detail.metrics.map((metric) => metric.machineId))).toEqual(new Set([alpha.id, beta.id]));

    // Jobs carry the tenant that was renting the GPU at probe time, and the
    // per-card view returns them across machines with the machine name.
    expect(db.listProcesses(alpha.id!)[0]).toMatchObject({ owner: "iota", gpuUuid: uuid });
    expect(detail.processes).toHaveLength(1);
    expect(detail.processes[0]).toMatchObject({ pid: 42, owner: "iota", machineName: "alpha", commandLine: "python train.py" });

    expect(db.getGpu("GPU-nope")).toBeUndefined();

    // Backdate the alpha-era samples to yesterday: the daily rollup folds the
    // completed day into gpu_daily_stats and survives retention pruning.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.raw.prepare("UPDATE gpu_metrics SET checked_at = ? WHERE poll_run_id IN (?, ?)").run(yesterday, run1, run2);
    expect(db.rollupGpuDailyStats()).toBeGreaterThan(0);
    const rolled = db.getGpu(uuid)!;
    expect(rolled.dailyStats).toHaveLength(1);
    expect(rolled.dailyStats[0]).toMatchObject({
      day: yesterday.slice(0, 10),
      sampleCount: 2,
      avgGpuUtil: 47.5,
      maxGpuUtil: 95,
      avgPowerW: 160,
      maxPowerW: 300,
    });
    // Finalized days are watermarked, so the per-poll call becomes a no-op.
    expect(db.rollupGpuDailyStats()).toBe(0);

    db.close();
  });

  it("stamps down events with the last known uuid for the slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-db-uuid-down-"));
    const db = createDatabase(join(dir, "test.sqlite"));
    db.migrate();

    const uuid = "GPU-cccc1111-2222-3333-4444-555566667777";
    const machine = db.upsertMachine({ name: "alpha", ip: "10.0.0.1", sshHost: "10.0.0.1", sshPort: 22, owner: "iota" });

    const healthyRun = db.createPollRun(1);
    db.insertProbeResult(healthyRun, machine.id!, {
      name: "alpha", ip: "10.0.0.1", owner: "iota", sshOk: true, status: "ok",
      gpuCount: 2, gpuJobs: "xx",
      gpuMetrics: [{ gpuIndex: 0, uuid }, { gpuIndex: 1, uuid: "GPU-dddd1111-2222-3333-4444-555566667777" }],
    });
    db.finishPollRun(healthyRun);

    // GPU 0 falls off the bus: no telemetry for it, but the down event still
    // resolves the physical card from its last sighting in that slot.
    const downRun = db.createPollRun(1);
    db.insertProbeResult(downRun, machine.id!, {
      name: "alpha", ip: "10.0.0.1", owner: "iota", sshOk: true, status: "degraded",
      gpuCount: 2, gpuJobs: "Ex",
      gpuMetrics: [{ gpuIndex: 1, uuid: "GPU-dddd1111-2222-3333-4444-555566667777" }],
    });
    db.finishPollRun(downRun);

    const downEvent = db.raw.prepare("SELECT gpu_uuid FROM gpu_down_events WHERE machine_id = ? AND gpu_index = 0 AND recovered_at IS NULL").get(machine.id) as { gpu_uuid: string };
    expect(downEvent.gpu_uuid).toBe(uuid);

    db.close();
  });

  it("tracks active GPU down notes until a successful recovery probe clears them", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-db-notes-"));
    const db = createDatabase(join(dir, "test.sqlite"));
    db.migrate();

    const machine = db.upsertMachine({
      name: "alpha",
      ip: "10.0.0.1",
      sshHost: "10.0.0.1",
      sshPort: 22,
    });
    const downRunId = db.createPollRun(1);
    db.insertProbeResult(downRunId, machine.id!, {
      name: "alpha",
      ip: "10.0.0.1",
      sshOk: true,
      status: "degraded",
      gpuCount: 4,
      gpuJobs: "xExx",
    });
    db.finishPollRun(downRunId);

    const downNote = db.listMachines()[0]?.activeGpuNotes?.[0];
    expect(downNote).toMatchObject({
      gpuIndex: 1,
    });
    expect(downNote?.note).toContain("GPU 1 down since");

    const repeatedRunId = db.createPollRun(1);
    db.insertProbeResult(repeatedRunId, machine.id!, {
      name: "alpha",
      ip: "10.0.0.1",
      sshOk: true,
      status: "degraded",
      gpuCount: 4,
      gpuJobs: "xExx",
    });
    db.finishPollRun(repeatedRunId);

    expect(db.listMachines()[0]?.activeGpuNotes?.[0]?.downSince).toBe(downNote?.downSince);

    const recoveredRunId = db.createPollRun(1);
    db.insertProbeResult(recoveredRunId, machine.id!, {
      name: "alpha",
      ip: "10.0.0.1",
      sshOk: true,
      status: "ok",
      gpuCount: 4,
      gpuJobs: "xxxx",
    });
    db.finishPollRun(recoveredRunId);

    expect(db.listMachines()[0]?.activeGpuNotes).toEqual([]);

    db.close();
  });
});
