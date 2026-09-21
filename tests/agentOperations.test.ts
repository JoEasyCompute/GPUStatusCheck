import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentInstallResult, AgentInstallTarget } from "../src/server/agentInstaller";
import { AgentOperationRunner, type RunAgentAction } from "../src/server/agentOperations";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db";

describe("agent operation runner", () => {
  it("returns immediately and never exceeds configured concurrency", async () => {
    const { db, config, targets } = setup(4, { agentInstallJobs: 2 });
    const operation = db.createAgentOperation("install", targets);
    const release = deferred<void>();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const run: RunAgentAction = async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active -= 1;
      return { outcome: "succeeded", summary: "installed", output: "active" };
    };
    const runner = new AgentOperationRunner(db, config, run);

    expect(runner.start(operation.id)).toBeUndefined();
    await expect.poll(() => calls).toBe(2);
    expect(maxActive).toBe(2);
    expect(db.getAgentOperation(operation.id)?.status).toBe("running");
    release.resolve();
    await expect.poll(() => db.getAgentOperation(operation.id)?.status).toBe("complete");
    expect(calls).toBe(4);
    expect(maxActive).toBe(2);
    db.close();
  });

  it("continues after failures, sanitizes output, and releases every machine lock", async () => {
    const { db, config, targets } = setup(3, { adminApiKey: "admin-secret", keyPath: "/keys/private", agentOutputMaxChars: 40 });
    const operation = db.createAgentOperation("install", targets);
    const results: Array<AgentInstallResult | Error> = [
      { outcome: "succeeded", summary: "installed", output: "admin-secret\u0000 /keys/private " + "x".repeat(80) },
      { outcome: "skipped", summary: "no sudo", output: "" },
      new Error("unexpected ssh crash"),
    ];
    const run: RunAgentAction = async (_target: AgentInstallTarget) => {
      const next = results.shift()!;
      if (next instanceof Error) throw next;
      return next;
    };
    const runner = new AgentOperationRunner(db, config, run);

    runner.start(operation.id);
    await expect.poll(() => db.getAgentOperation(operation.id)?.status).toBe("failed");
    const detail = db.getAgentOperation(operation.id)!;
    expect(detail).toMatchObject({ succeededCount: 1, skippedCount: 1, failedCount: 1 });
    expect(detail.items[0]?.output).not.toContain("admin-secret");
    expect(detail.items[0]?.output).not.toContain("/keys/private");
    expect(detail.items[0]?.output).not.toContain("\u0000");
    expect(detail.items[0]?.output.length).toBeLessThanOrEqual(40);
    expect(detail.items[2]).toMatchObject({ status: "failed", summary: "installer error" });
    for (const target of targets) expect(runner.isMachineBusy(target.machineId)).toBe(false);
    expect(() => db.createAgentOperation("uninstall", [targets[2]!])).not.toThrow();
    db.close();
  });

  it("marks unfinished work interrupted on recovery without running SSH", () => {
    const { db, config, targets } = setup(1);
    const operation = db.createAgentOperation("install", targets);
    db.markAgentOperationRunning(operation.id);
    db.markAgentOperationItemRunning(operation.items[0]!.id);
    let calls = 0;
    const runner = new AgentOperationRunner(db, config, async () => {
      calls += 1;
      return { outcome: "succeeded", summary: "installed", output: "" };
    });

    expect(runner.recoverInterrupted()).toBe(1);
    expect(calls).toBe(0);
    expect(db.getAgentOperation(operation.id)).toMatchObject({
      status: "interrupted",
      interruptedCount: 1,
      items: [expect.objectContaining({ status: "interrupted" })],
    });
    db.close();
  });
});

function setup(count: number, overrides: Partial<AppConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gpu-agent-runner-"));
  const db = createDatabase(join(dir, "db.sqlite"));
  db.migrate();
  const targets = Array.from({ length: count }, (_, index) => {
    const machine = db.upsertMachine({
      name: `machine-${index + 1}`,
      ip: `10.0.0.${index + 1}`,
      sshHost: `10.0.0.${index + 1}`,
      sshPort: 22,
    });
    return { machineId: machine.id!, machineName: machine.name };
  });
  const config: AppConfig = {
    machinesPath: join(dir, "machines.csv"), dbPath: join(dir, "db.sqlite"), envPath: join(dir, ".env"),
    user: "ezc", fallbackUser: "", keyPath: "/keys/test", connectTimeoutSeconds: 10, probeTimeoutSeconds: 60,
    jobs: 2, pollIntervalSeconds: 300, skipLogs: true, processArgsMaxChars: 512, pollOnStartup: false,
    retentionDays: 30, minFreeDiskBytes: 0, adminApiKey: "", agentInstallJobs: 2, agentMaxBatch: 100,
    agentOperationRetentionDays: 30, agentOutputMaxChars: 4000, telegramBotToken: "", telegramChatId: "",
    slackBotToken: "", slackChannelsPath: "", slackDryRun: false, agentDrainEnabled: false,
    agentDrainTimeoutSeconds: 120, agentDrainMaxLines: 600, agentRetentionDays: 21, notifyRecovery: false,
    heartbeatUrl: "", host: "127.0.0.1", port: 0, ...overrides,
  };
  return { db, config, targets };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
