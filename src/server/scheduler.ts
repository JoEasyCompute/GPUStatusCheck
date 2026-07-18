import type { Machine, PollStatus, ProbeResult } from "../shared/types";
import type { AppConfig } from "./config";
import type { DashboardDatabase } from "./db";
import { readInventoryFromFile } from "./inventory";
import { runProbe } from "./probe";

export type ProbeMachine = (machine: Machine) => Promise<ProbeResult>;

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
      await runConcurrent(storedMachines, Math.max(1, this.config.jobs), async (machine) => {
        const result = await this.probeMachine(machine);
        this.db.insertProbeResult(runId, machine.id!, result);
      });
      this.db.finishPollRun(runId);
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

    return { runId, skipped: false };
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
