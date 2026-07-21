import type { Machine, PollStatus, ProbeResult } from "../shared/types";
import { buildAlerts, formatAlertMessage, sendTelegramMessage, splitMessage, type AlertInput } from "./alerts";
import type { AppConfig } from "./config";
import type { DashboardDatabase } from "./db";
import { detectGpuDrops } from "./gpuDrops";
import { readInventoryFromFile } from "./inventory";
import { runProbe } from "./probe";
import {
  buildAllRecoveredMessage,
  buildDropMessage,
  buildRecoveryMessage,
  loadChannelMap,
  postSlack,
  resolveChannel,
  type SendSlack,
} from "./slack";

/** A malformed or missing channel map must never abort a poll. */
function safeLoadChannelMap(path: string) {
  try {
    return loadChannelMap(path);
  } catch (error) {
    console.error("loading slack channel map failed", error);
    return {};
  }
}

export type ProbeMachine = (machine: Machine) => Promise<ProbeResult>;
export type SendAlertChunk = (chunk: string) => Promise<void>;

type ProbeObservation = {
  machine: Machine;
  visibleUuids: string[];
  sshOk: boolean;
  gpuCount: number;
  reason: string;
};

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
        fallbackUser: config.fallbackUser,
        keyPath: config.keyPath,
        connectTimeoutSeconds: config.connectTimeoutSeconds,
        probeTimeoutSeconds: config.probeTimeoutSeconds,
        checkLogs: !config.skipLogs,
        processArgsMaxChars: config.processArgsMaxChars,
      }),
    private readonly sendAlertChunk: SendAlertChunk = (chunk) =>
      sendTelegramMessage(config.telegramBotToken, config.telegramChatId, chunk),
    private readonly sendSlack: SendSlack = (post) => postSlack(config.slackBotToken, post),
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
      const observations: ProbeObservation[] = [];
      await runConcurrent(storedMachines, Math.max(1, this.config.jobs), async (machine) => {
        const result = await this.probeMachine(machine);
        this.applyExpectedGpuCount(machine, result);
        // The roster diff must run against the cards this probe saw, before the
        // sightings table is updated by insertProbeResult.
        observations.push({
          machine,
          visibleUuids: (result.gpuMetrics ?? []).map((metric) => metric.uuid ?? "").filter(Boolean),
          sshOk: result.sshOk === true,
          gpuCount: result.gpuCount ?? 0,
          reason: result.busOffReason || result.nvidiaSmiError || "",
        });
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
        this.recordGpuDrops(observations);
      } catch (error) {
        console.error("gpu drop detection failed", error);
      }
      try {
        const pruned = this.db.pruneHistory(this.config.retentionDays);
        if (pruned > 0) {
          console.log(`pruned ${pruned} history rows older than ${this.config.retentionDays} days`);
        }
      } catch (error) {
        console.error("history prune failed", error);
      }
      await this.deliverAlerts(outcomes);
      await this.deliverGpuDropAnnouncements();
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

  /**
   * Diffs each machine's expected GPU roster against what the probe reported and
   * records incidents. Recording is independent of delivery: rows are written
   * even for owners with no Slack channel and for muted machines, so history
   * stays complete and unmuting never replays old drops.
   */
  private recordGpuDrops(observations: ProbeObservation[]): void {
    const channelMap = this.config.slackBotToken || this.config.slackDryRun
      ? safeLoadChannelMap(this.config.slackChannelsPath)
      : {};
    const at = new Date().toISOString();

    for (const observation of observations) {
      const machineId = observation.machine.id;
      if (!machineId) {
        continue;
      }
      const roster = this.db.listMachineRoster(machineId);
      const detection = detectGpuDrops(roster, observation);
      const open = this.db.getOpenDropIncident(machineId);

      if (detection.skipped) {
        continue;
      }

      if (open) {
        const recovered = open.members
          .filter((member) => !member.recoveredAt && detection.visible.has(member.uuid))
          .map((member) => member.uuid);
        if (recovered.length > 0) {
          this.db.closeDropMembers(open.id, recovered, at);
        }
        // Cards that dropped after the incident opened join the same thread.
        const known = new Set(open.members.map((member) => member.uuid));
        const additional = detection.dropped.filter((entry) => !known.has(entry.uuid));
        if (additional.length > 0) {
          this.db.addDropMembers(open.id, additional, at);
        }
        continue;
      }

      if (detection.dropped.length === 0) {
        continue;
      }
      const owner = (observation.machine.owner ?? "").trim();
      const channel = resolveChannel(owner, channelMap)?.channel ?? "";
      this.db.openDropIncident({
        machineId,
        owner,
        channel: observation.machine.maintenance === true ? "" : channel,
        dropped: detection.dropped,
        visibleCount: detection.visible.size,
        expectedCount: roster.length,
        wholeMachine: detection.wholeMachine,
        reason: observation.reason,
        at,
      });
      console.log(`gpu drop: ${observation.machine.name} lost ${detection.dropped.length}/${roster.length} GPUs`);
    }
  }

  /**
   * Posts pending incident messages. Announcement timestamps are written only
   * after Slack confirms, so any failure simply retries on the next poll, and a
   * recovery reply is never attempted before its parent thread exists.
   */
  private async deliverGpuDropAnnouncements(): Promise<void> {
    if (!this.config.slackBotToken && !this.config.slackDryRun) {
      return;
    }
    const channelMap = safeLoadChannelMap(this.config.slackChannelsPath);
    let incidents: ReturnType<DashboardDatabase["listPendingDropIncidents"]>;
    try {
      incidents = this.db.listPendingDropIncidents();
    } catch (error) {
      console.error("reading pending gpu drop incidents failed", error);
      return;
    }

    for (const incident of incidents) {
      if (incident.maintenance) {
        continue;
      }
      const mention = resolveChannel(incident.owner, channelMap)?.mention;
      try {
        if (!incident.announcedAt) {
          const text = buildDropMessage({
            machineName: incident.machineName,
            owner: incident.owner,
            dropped: incident.members.map((member) => ({
              uuid: member.uuid,
              gpuIndex: member.gpuIndex,
              gpuType: member.gpuType,
            })),
            visibleCount: incident.visibleCount,
            expectedCount: incident.expectedCount,
            wholeMachine: incident.wholeMachine,
            reason: incident.reason,
            mention,
          });
          const ts = await this.postOrLog({ channel: incident.channel, text });
          this.db.markIncidentAnnounced(incident.id, ts, new Date().toISOString());
          incident.slackTs = ts;
          incident.announcedAt = new Date().toISOString();
        }

        for (const member of incident.members) {
          if (!member.recoveredAt || member.recoveryAnnouncedAt) {
            continue;
          }
          await this.postOrLog({
            channel: incident.channel,
            text: buildRecoveryMessage(
              { uuid: member.uuid, gpuIndex: member.gpuIndex, gpuType: member.gpuType },
              member.droppedAt,
              member.recoveredAt,
            ),
            threadTs: incident.slackTs || undefined,
            broadcast: true,
          });
          this.db.markRecoveryAnnounced(member.id, new Date().toISOString());
        }

        if (incident.closedAt && !incident.allRecoveredAnnouncedAt) {
          await this.postOrLog({
            channel: incident.channel,
            text: buildAllRecoveredMessage(incident.machineName),
            threadTs: incident.slackTs || undefined,
          });
          this.db.markAllRecoveredAnnounced(incident.id, new Date().toISOString());
        }
      } catch (error) {
        console.error(`slack announcement failed for incident ${incident.id}; will retry next poll`, error);
      }
    }
  }

  private async postOrLog(post: { channel: string; text: string; threadTs?: string; broadcast?: boolean }): Promise<string> {
    if (this.config.slackDryRun) {
      console.log(`[slack dry-run] channel=${post.channel}${post.threadTs ? ` thread=${post.threadTs}` : ""}\n${post.text}`);
      return post.threadTs ?? `dry-run-${Date.now()}`;
    }
    return this.sendSlack(post);
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
