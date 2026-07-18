import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app";
import { createDatabase } from "../src/server/db";
import type { ProbeResult } from "../src/shared/types";

describe("api", () => {
  it("serves summary, machines, history, processes, and manual poll trigger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-api-"));
    const csvPath = join(dir, "machines.csv");
    const envPath = join(dir, ".env");
    writeFileSync(csvPath, "name,ip,platform,owner,commission_date\nalpha,10.0.0.1,gc,ops,2026-01-01\n");
    writeFileSync(envPath, "GPUCHECK_MACHINES=old.csv\nGPUCHECK_POLL_INTERVAL_SECONDS=300\nGPUCHECK_DB=data/gpu-status.sqlite\n");
    const db = createDatabase(join(dir, "db.sqlite"));
    db.migrate();
    let probeCalls = 0;

    const app = buildApp({
      db,
      config: {
        machinesPath: csvPath,
        dbPath: join(dir, "db.sqlite"),
        user: "ezc",
        keyPath: "~/.ssh/test",
        connectTimeoutSeconds: 10,
        probeTimeoutSeconds: 60,
        jobs: 2,
        pollIntervalSeconds: 300,
        skipLogs: true,
        processArgsMaxChars: 512,
        pollOnStartup: false,
        retentionDays: 30,
        port: 0,
        envPath,
      },
      probeMachine: async (machine): Promise<ProbeResult> => {
        probeCalls += 1;
        return {
          name: machine.name,
          ip: machine.ip,
          sshOk: true,
          status: "ok",
          gpuCount: 1,
          gpuJobs: "D",
          gpuPowerW: "250.5",
          gpuAvgTempC: "61.0",
          processes: [{ gpuIndex: 0, pid: 123, commandLine: "python train.py" }],
        };
      },
    });

    const poll = await app.inject({ method: "POST", url: "/api/poll-runs" });
    expect(poll.statusCode).toBe(200);
    expect(probeCalls).toBe(1);

    const config = await app.inject({ method: "GET", url: "/api/config" });
    expect(config.json()).toMatchObject({
      machinesPath: csvPath,
      dbPath: join(dir, "db.sqlite"),
      jobs: 2,
      pollIntervalSeconds: 300,
      pollOnStartup: false,
      port: 0,
      envPath,
      sshUser: "ezc",
    });
    expect(config.body).not.toContain("keyPath");

    const settings = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        machinesPath: "iota.csv",
        pollIntervalSeconds: 120,
      },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      machinesPath: "iota.csv",
      pollIntervalSeconds: 120,
      envPath,
    });
    const envText = readFileSync(envPath, "utf8");
    expect(envText).toContain("GPUCHECK_MACHINES=iota.csv");
    expect(envText).toContain("GPUCHECK_POLL_INTERVAL_SECONDS=120");

    const updatedConfig = await app.inject({ method: "GET", url: "/api/config" });
    expect(updatedConfig.json()).toMatchObject({
      machinesPath: "iota.csv",
      pollIntervalSeconds: 120,
    });

    const summary = await app.inject({ method: "GET", url: "/api/summary" });
    expect(summary.json()).toMatchObject({ total: 1, ok: 1, totalPowerW: 250.5 });

    const machines = await app.inject({ method: "GET", url: "/api/machines" });
    const machine = machines.json()[0];
    expect(machine.latest.gpuJobs).toBe("D");

    const history = await app.inject({ method: "GET", url: `/api/machines/${machine.id}/history` });
    expect(history.json()[0].gpuPowerW).toBe("250.5");

    const processes = await app.inject({ method: "GET", url: `/api/machines/${machine.id}/processes` });
    expect(processes.json()[0].commandLine).toBe("python train.py");

    const badLimit = await app.inject({ method: "GET", url: `/api/machines/${machine.id}/history?limit=abc` });
    expect(badLimit.statusCode).toBe(200);
    expect(badLimit.json()).toHaveLength(1);

    const unknownApi = await app.inject({ method: "GET", url: "/api/nope" });
    expect(unknownApi.statusCode).toBe(404);

    await app.close();
    db.close();
  });

  it("reports running poll status and skipped manual polls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-api-status-"));
    const csvPath = join(dir, "machines.csv");
    const envPath = join(dir, ".env");
    writeFileSync(csvPath, "name,ip\nalpha,10.0.0.1\nbeta,10.0.0.2\n");
    const db = createDatabase(join(dir, "db.sqlite"));
    db.migrate();
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });

    const app = buildApp({
      db,
      config: {
        machinesPath: csvPath,
        dbPath: join(dir, "db.sqlite"),
        envPath,
        user: "ezc",
        keyPath: "~/.ssh/test",
        connectTimeoutSeconds: 10,
        probeTimeoutSeconds: 60,
        jobs: 1,
        pollIntervalSeconds: 300,
        skipLogs: true,
        processArgsMaxChars: 512,
        pollOnStartup: false,
        retentionDays: 30,
        port: 0,
      },
      probeMachine: async (machine): Promise<ProbeResult> => {
        await probeGate;
        return {
          name: machine.name,
          ip: machine.ip,
          sshOk: true,
          status: "ok",
        };
      },
    });

    const firstPoll = app.inject({ method: "POST", url: "/api/poll-runs" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const runningStatus = await app.inject({ method: "GET", url: "/api/poll-status" });
    expect(runningStatus.json()).toMatchObject({
      running: true,
      machinesPath: csvPath,
      pollIntervalSeconds: 300,
      machineCount: 2,
    });
    expect(runningStatus.json().elapsedMs).toBeGreaterThanOrEqual(0);

    const skippedPoll = await app.inject({ method: "POST", url: "/api/poll-runs" });
    expect(skippedPoll.json()).toMatchObject({ runId: 0, skipped: true });

    const skippedStatus = await app.inject({ method: "GET", url: "/api/poll-status" });
    expect(skippedStatus.json().lastSkippedAt).toBeTruthy();

    releaseProbe?.();
    await firstPoll;

    const idleStatus = await app.inject({ method: "GET", url: "/api/poll-status" });
    expect(idleStatus.json()).toMatchObject({
      running: false,
      lastError: "",
    });
    expect(idleStatus.json().lastFinishedAt).toBeTruthy();

    await app.close();
    db.close();
  });
});
