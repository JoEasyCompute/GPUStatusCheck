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
