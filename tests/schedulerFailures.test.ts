import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db";
import { PollScheduler } from "../src/server/scheduler";
import type { Machine, ProbeResult } from "../src/shared/types";

describe("poll failure handling", () => {
  it("runs a queued poll after the active poll fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-scheduler-queued-failure-"));
    const csvPath = join(dir, "machines.csv");
    writeFileSync(csvPath, "name,ip\nalpha,10.0.0.1\n");
    const db = createDatabase(join(dir, "db.sqlite"));
    db.migrate();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let calls = 0;
    const scheduler = new PollScheduler(db, makeConfig(csvPath, dir), async (machine) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        throw new Error("first poll failed");
      }
      return okResult(machine);
    });

    const failedPoll = scheduler.pollOnce();
    await firstStarted.promise;
    scheduler.pollSoon();
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst.resolve();

    await expect(failedPoll).rejects.toMatchObject({ message: "first poll failed" });
    await expect.poll(() => calls).toBe(2);
    await expect.poll(() => scheduler.getStatus().running).toBe(false);
    expect(scheduler.getStatus().lastError).toBe("");
    db.close();
  });

  it("keeps the polling lock until sibling workers settle after a failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-scheduler-failure-"));
    const csvPath = join(dir, "machines.csv");
    writeFileSync(csvPath, "name,ip\nalpha,10.0.0.1\nbeta,10.0.0.2\n");
    const db = createDatabase(join(dir, "db.sqlite"));
    db.migrate();
    const secondStarted = deferred<void>();
    const releaseSecond = deferred<void>();
    const alphaThrew = deferred<void>();
    const scheduler = new PollScheduler(db, makeConfig(csvPath, dir), async (machine) => {
      if (machine.name === "alpha") {
        await secondStarted.promise;
        alphaThrew.resolve();
        throw new Error("alpha probe failed");
      }
      secondStarted.resolve();
      await releaseSecond.promise;
      return okResult(machine);
    });

    const failedPoll = scheduler.pollOnce();
    await alphaThrew.promise;
    await new Promise((resolve) => setImmediate(resolve));

    try {
      expect(scheduler.getStatus().running).toBe(true);
      await expect(scheduler.pollOnce()).resolves.toMatchObject({ runId: 0, skipped: true });
    } finally {
      releaseSecond.resolve();
    }

    await expect(failedPoll).rejects.toMatchObject({
      runId: expect.any(Number),
      message: "alpha probe failed",
    });
    expect(scheduler.getStatus()).toMatchObject({ running: false, lastError: "alpha probe failed" });
    db.close();
  });
});

function makeConfig(csvPath: string, dir: string): AppConfig {
  return {
    machinesPath: csvPath,
    dbPath: join(dir, "db.sqlite"),
    envPath: join(dir, ".env"),
    user: "ezc",
    fallbackUser: "",
    keyPath: "~/.ssh/test",
    connectTimeoutSeconds: 10,
    probeTimeoutSeconds: 60,
    jobs: 2,
    pollIntervalSeconds: 300,
    skipLogs: true,
    processArgsMaxChars: 512,
    pollOnStartup: false,
    retentionDays: 30,
    minFreeDiskBytes: 5 * 1024 ** 3,
    adminApiKey: "",
    agentInstallJobs: 4,
    agentMaxBatch: 100,
    agentOperationRetentionDays: 30,
    agentOutputMaxChars: 4000,
    telegramBotToken: "",
    telegramChatId: "",
    slackBotToken: "",
    slackChannelsPath: "",
    slackDryRun: false,
    agentDrainEnabled: false,
    agentDrainTimeoutSeconds: 120,
    agentDrainMaxLines: 600,
    agentRetentionDays: 21,
    notifyRecovery: false,
    heartbeatUrl: "",
    host: "127.0.0.1",
    port: 0,
  };
}

function okResult(machine: Machine): ProbeResult {
  return {
    name: machine.name,
    ip: machine.ip,
    sshOk: true,
    status: "ok",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
