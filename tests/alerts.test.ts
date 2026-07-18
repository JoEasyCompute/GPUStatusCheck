import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAlerts, formatAlertMessage, splitMessage } from "../src/server/alerts";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db";
import { PollScheduler } from "../src/server/scheduler";
import type { ProbeResult } from "../src/shared/types";

describe("alerts", () => {
  it("emits alerts only on status transitions", () => {
    const results = [
      { name: "alpha", ip: "10.0.0.1", status: "degraded", reason: "kernel/log indicators" },
      { name: "beta", ip: "10.0.0.2", status: "ssh_failed", reason: "connection refused" },
      { name: "gamma", ip: "10.0.0.3", status: "ok", reason: "" },
    ];

    const first = buildAlerts(results, {}, false);
    expect(first.lines).toHaveLength(2);
    expect(first.lines[0]).toContain("DEGRADED");
    expect(first.lines[1]).toContain("SSH FAILED");
    expect(first.nextStates).toEqual({ alpha: "degraded", beta: "ssh_failed", gamma: "ok" });

    const repeat = buildAlerts(results, first.nextStates, false);
    expect(repeat.lines).toEqual([]);
  });

  it("emits recovery alerts only when enabled", () => {
    const results = [{ name: "alpha", ip: "10.0.0.1", status: "ok", reason: "" }];
    const previous = { alpha: "degraded" };

    expect(buildAlerts(results, previous, false).lines).toEqual([]);
    const withRecovery = buildAlerts(results, previous, true);
    expect(withRecovery.lines).toHaveLength(1);
    expect(withRecovery.lines[0]).toContain("RECOVERED: degraded → ok");
  });

  it("splits long messages and hard-splits oversized single lines", () => {
    const message = formatAlertMessage(
      Array.from({ length: 200 }, (_, i) => `• machine-${i} (10.0.0.${i}) DEGRADED: reason`),
      10,
      200,
      0,
    );
    const chunks = splitMessage(message, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);

    const oneGiantLine = "x".repeat(1200);
    const hardSplit = splitMessage(`short\n${oneGiantLine}`, 500);
    expect(hardSplit.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(hardSplit.join("").replace(/\n/g, "")).toBe(`short${oneGiantLine}`);
  });

  it("sends transition alerts from the scheduler and retries after delivery failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-alerts-"));
    const csvPath = join(dir, "machines.csv");
    writeFileSync(csvPath, "name,ip\nalpha,10.0.0.1\n");
    const db = createDatabase(join(dir, "db.sqlite"));
    db.migrate();

    const config: AppConfig = {
      machinesPath: csvPath,
      dbPath: join(dir, "db.sqlite"),
      envPath: join(dir, ".env"),
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
      telegramBotToken: "token",
      telegramChatId: "chat",
      notifyRecovery: false,
      host: "127.0.0.1",
      port: 0,
    };

    let status: ProbeResult["status"] = "ssh_failed";
    const sent: string[] = [];
    let failSend = false;
    const scheduler = new PollScheduler(
      db,
      config,
      async (machine): Promise<ProbeResult> => ({
        name: machine.name,
        ip: machine.ip,
        sshOk: status !== "ssh_failed",
        sshError: status === "ssh_failed" ? "connection refused" : "",
        status,
      }),
      async (chunk) => {
        if (failSend) {
          throw new Error("telegram down");
        }
        sent.push(chunk);
      },
    );

    // Failed delivery keeps the previous state so the alert retries.
    failSend = true;
    await scheduler.pollOnce();
    expect(sent).toHaveLength(0);
    expect(db.getAlertStates()).toEqual({});

    // Next poll retries the same transition and succeeds.
    failSend = false;
    await scheduler.pollOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("alpha (10.0.0.1) SSH FAILED: connection refused");
    expect(db.getAlertStates()).toEqual({ alpha: "ssh_failed" });

    // Unchanged status stays silent.
    await scheduler.pollOnce();
    expect(sent).toHaveLength(1);

    // Silent recovery still updates the stored state.
    status = "ok";
    await scheduler.pollOnce();
    expect(sent).toHaveLength(1);
    expect(db.getAlertStates()).toEqual({ alpha: "ok" });

    db.close();
  });
});
