import type { Machine, PollStatus, ProbeResult } from "../shared/types";
import { buildAlerts, formatAlertMessage, sendTelegramMessage, splitMessage, type AlertInput } from "./alerts";
import type { AppConfig } from "./config";
import type { DashboardDatabase } from "./db";
import { readInventoryFromFile } from "./inventory";
import { runProbe } from "./probe";

export type ProbeMachine = (machine: Machine) => Promise<ProbeResult>;
export type SendAlertChunk = (chunk: string) => Promise<void>;

export class PollScheduler {
  private running = false;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private currentPoll:
    | {
        startedAt: string;
        runId?: number;
        machineCount?: number;
      }
    | undefined;
  private lastSkippedAt: string | undefined;
  private lastFinishedAt: string | undefined;
  private lastError = "";
  private pendingPoll = false;

  constructor(
    private readonly db: DashboardDatabase,
    private readonly config: AppConfig,
    private readonly probeMachine: ProbeMachine = (machine) =>
      runProbe(machine, {
        user: config.user,
        keyPath: config.keyPath,
        connectTimeoutSeconds: config.connectTimeoutSeconds,
        probeTimeoutSeconds: config.probeTimeoutSeconds,
        checkLogs: !config.skipLogs,
        processArgsMaxChars: config.processArgsMaxChars,
      }),
    private readonly sendAlertChunk: SendAlertChunk = (chunk) =>
      sendTelegramMessage(config.telegramBotToken, config.telegramChatId, chunk),
  ) {}

  start(): void {
    this.started = true;
    if (this.config.pollOnStartup) {
      void this.pollOnce().catch((error) => {
        console.error("startup poll failed", error);
      });
    }
    this.schedule();
  }

  updateConfig(updates: Pick<AppConfig, "machinesPath" | "pollIntervalSeconds">): void {
    Object.assign(this.config, updates);
    if (this.started) {
      this.schedule();
    }
  }

  /**
   * Poll as soon as possible: immediately when idle, otherwise queued to run
   * right after the in-flight poll finishes (so a config change never has to
   * wait a full interval to take effect).
   */
  pollSoon(): void {
    void this.pollOnce().then((result) => {
      if (result.skipped) {
        this.pendingPoll = true;
      }
    }).catch((error) => {
      console.error("triggered poll failed", error);
    });
  }

  getStatus(): PollStatus {
    return {
      running: this.running,
      startedAt: this.currentPoll?.startedAt,
      elapsedMs: this.currentPoll?.startedAt ? Date.now() - Date.parse(this.currentPoll.startedAt) : undefined,
      currentRunId: this.currentPoll?.runId,
      machineCount: this.currentPoll?.machineCount,
      machinesPath: this.config.machinesPath,
      pollIntervalSeconds: this.config.pollIntervalSeconds,
      lastSkippedAt: this.lastSkippedAt,
      lastFinishedAt: this.lastFinishedAt,
      lastError: this.lastError,
    };
  }

  private schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        console.error("scheduled poll failed", error);
      });
    }, Math.max(1, this.config.pollIntervalSeconds) * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.started = false;
  }

  async pollOnce(): Promise<{ runId: number; skipped: boolean }> {
    if (this.running) {
      this.lastSkippedAt = new Date().toISOString();
      return { runId: 0, skipped: true };
    }
    this.running = true;
    this.currentPoll = { startedAt: new Date().toISOString() };
    this.lastError = "";
    let runId = 0;

    try {
      const machines = readInventoryFromFile(this.config.machinesPath);
      this.currentPoll.machineCount = machines.length;
      const storedMachines = machines.map((machine) => this.db.upsertMachine(machine));
      this.db.markMissingInactive(machines.map((machine) => machine.name));
      runId = this.db.createPollRun(storedMachines.length);
      this.currentPoll.runId = runId;
      const outcomes: AlertInput[] = [];
      await runConcurrent(storedMachines, Math.max(1, this.config.jobs), async (machine) => {
        const result = await this.probeMachine(machine);
        this.applyExpectedGpuCount(machine, result);
        this.db.insertProbeResult(runId, machine.id!, result);
        outcomes.push({
          name: machine.name,
          ip: machine.ip,
          status: result.status,
          reason: result.busOffReason || result.sshError || "",
          muted: machine.maintenance === true,
        });
      });
      this.db.finishPollRun(runId);
      try {
        const pruned = this.db.pruneHistory(this.config.retentionDays);
        if (pruned > 0) {
          console.log(`pruned ${pruned} history rows older than ${this.config.retentionDays} days`);
        }
      } catch (error) {
        console.error("history prune failed", error);
      }
      await this.deliverAlerts(outcomes);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (runId > 0) {
        this.db.finishPollRun(runId, this.lastError);
      } else {
        throw error;
      }
    } finally {
      this.running = false;
      this.currentPoll = undefined;
      this.lastFinishedAt = new Date().toISOString();
    }

    if (!this.lastError && this.config.heartbeatUrl) {
      // Dead-man's-switch ping: if these stop arriving, the watchdog service
      // alerts that the monitor itself is down.
      fetch(this.config.heartbeatUrl).catch((error) => {
        console.error("heartbeat ping failed", error);
      });
    }

    if (this.pendingPoll) {
      this.pendingPoll = false;
      setTimeout(() => {
        void this.pollOnce().catch((error) => {
          console.error("queued poll failed", error);
        });
      }, 50);
    }

    return { runId, skipped: false };
  }

  /**
   * A machine's expected GPU count is the highest count a healthy probe has
   * ever reported. A later healthy probe seeing fewer GPUs means one fell off
   * the bus without leaving kernel-log evidence, so degrade the result to
   * make the transition alert fire.
   */
  private applyExpectedGpuCount(machine: Machine, result: ProbeResult): void {
    if (!result.sshOk || result.gpuCount === null || result.gpuCount === undefined) {
      return;
    }
    const expected = machine.expectedGpuCount ?? 0;
    if (result.gpuCount > expected) {
      this.db.raiseExpectedGpuCount(machine.id!, result.gpuCount);
      return;
    }
    if (result.status === "ok" && result.gpuCount < expected) {
      result.status = "degraded";
      result.busOffReason = [result.busOffReason, `only ${result.gpuCount}/${expected} GPUs visible`]
        .filter(Boolean)
        .join("; ");
    }
  }

  private async deliverAlerts(outcomes: AlertInput[]): Promise<void> {
    try {
      const previous = this.db.getAlertStates();
      const { lines, nextStates } = buildAlerts(outcomes, previous, this.config.notifyRecovery);
      const configured = Boolean(this.config.telegramBotToken && this.config.telegramChatId);

      if (configured && lines.length > 0) {
        const ok = outcomes.filter((outcome) => outcome.status === "ok").length;
        const degraded = outcomes.filter((outcome) => outcome.status === "degraded").length;
        const sshFailed = outcomes.filter((outcome) => outcome.status === "ssh_failed").length;
        const message = formatAlertMessage(lines, ok, degraded, sshFailed);
        try {
          for (const chunk of splitMessage(message)) {
            await this.sendAlertChunk(chunk);
          }
          console.log(`sent telegram alert (${lines.length} machines)`);
        } catch (error) {
          // Keep the previous alert state so the transition re-alerts on the
          // next poll instead of being swallowed by a transient send failure.
          console.error("telegram alert failed; will retry next poll", error);
          return;
        }
      }

      this.db.saveAlertStates(nextStates);
    } catch (error) {
      console.error("alert delivery failed", error);
    }
  }
}

async function runConcurrent<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]!;
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}
