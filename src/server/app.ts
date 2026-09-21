import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EditableRuntimeConfig, HealthStatus, RuntimeConfig, StorageHealth } from "../shared/types";
import type { AppConfig } from "./config";
import { writeEnvSettings } from "./config";
import type { DashboardDatabase } from "./db";
import { readInventoryFromFile } from "./inventory";
import { PollFailedError, PollScheduler, type ProbeMachine } from "./scheduler";
import { readStorageHealth } from "./storageHealth";

export type BuildAppOptions = {
  db: DashboardDatabase;
  config: AppConfig;
  probeMachine?: ProbeMachine;
  storageHealthProvider?: () => Promise<StorageHealth>;
};

export function buildApp(options: BuildAppOptions) {
  const app = fastify({ logger: false });
  const scheduler = new PollScheduler(options.db, options.config, options.probeMachine);
  const storageHealthProvider = options.storageHealthProvider
    ?? (() => readStorageHealth(options.config.dbPath, options.config.minFreeDiskBytes));
  const runtimeConfig = (): RuntimeConfig => ({
    machinesPath: options.config.machinesPath,
    dbPath: options.config.dbPath,
    envPath: options.config.envPath,
    sshUser: options.config.user,
    jobs: options.config.jobs,
    pollIntervalSeconds: options.config.pollIntervalSeconds,
    skipLogs: options.config.skipLogs,
    processArgsMaxChars: options.config.processArgsMaxChars,
    pollOnStartup: options.config.pollOnStartup,
    minFreeDiskBytes: options.config.minFreeDiskBytes,
    agentInstallJobs: options.config.agentInstallJobs,
    agentMaxBatch: options.config.agentMaxBatch,
    port: options.config.port,
  });

  const startedAt = Date.now();
  app.get("/api/health", async (_request, reply): Promise<HealthStatus> => {
    const status = scheduler.getStatus();
    const lastPollAt = status.lastFinishedAt ? Date.parse(status.lastFinishedAt) : startedAt;
    const secondsSinceLastPoll = Math.floor((Date.now() - lastPollAt) / 1000);
    const staleAfterSeconds = Math.max(900, status.pollIntervalSeconds * 3);
    const storage = await storageHealthProvider();
    const reasons: string[] = [];
    if (secondsSinceLastPoll > staleAfterSeconds) {
      reasons.push("stale_poll");
    }
    if (storage.freeDiskBytes !== null && storage.freeDiskBytes < storage.minimumFreeDiskBytes) {
      reasons.push("low_disk_space");
    }
    const ok = reasons.length === 0;
    if (!ok) {
      reply.code(503);
    }
    return {
      ok,
      polling: status.running,
      lastPollFinishedAt: status.lastFinishedAt ?? null,
      secondsSinceLastPoll,
      staleAfterSeconds,
      lastError: status.lastError,
      reasons,
      storage,
    };
  });
  app.get("/api/config", async (): Promise<RuntimeConfig> => runtimeConfig());
  app.put<{ Body: Partial<EditableRuntimeConfig> }>("/api/config", async (request, reply) => {
    const machinesPath = String(request.body?.machinesPath ?? "").trim();
    const pollIntervalSeconds = Number(request.body?.pollIntervalSeconds);

    if (!machinesPath) {
      return reply.code(400).send({ error: "machinesPath is required" });
    }
    if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 1) {
      return reply.code(400).send({ error: "pollIntervalSeconds must be a positive integer" });
    }
    try {
      const machines = readInventoryFromFile(machinesPath);
      if (machines.length === 0) {
        return reply.code(400).send({ error: `no machines found in ${machinesPath}` });
      }
    } catch (error) {
      return reply.code(400).send({ error: `cannot read machines file: ${error instanceof Error ? error.message : String(error)}` });
    }

    writeEnvSettings(options.config.envPath, {
      GPUCHECK_MACHINES: machinesPath,
      GPUCHECK_POLL_INTERVAL_SECONDS: pollIntervalSeconds,
    });
    scheduler.updateConfig({ machinesPath, pollIntervalSeconds });
    scheduler.pollSoon();
    return runtimeConfig();
  });
  app.get("/api/summary", async () => options.db.getSummary());
  app.get("/api/poll-status", async () => scheduler.getStatus());
  app.get("/api/machines", async () => options.db.listMachines());
  app.get<{ Params: { id: string } }>("/api/machines/:id", async (request, reply) => {
    const machine = options.db.getMachine(Number(request.params.id));
    if (!machine) {
      return reply.code(404).send({ error: "machine not found" });
    }
    return machine;
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; hours?: string } }>("/api/machines/:id/history", async (request) => {
    const hours = Number(request.query.hours);
    const since = Number.isFinite(hours) && hours > 0
      ? new Date(Date.now() - Math.min(hours, 24 * 30) * 60 * 60 * 1000).toISOString()
      : undefined;
    // Higher cap than other routes: 24h of 60s agent samples plus 5-min polls
    // is ~1730 rows, and truncation would silently clip the oldest hours.
    return options.db.listHistory(Number(request.params.id), parseLimit(request.query.limit, 200, 3000), since);
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; hours?: string } }>("/api/machines/:id/kernel-events", async (request) => {
    const hours = Number(request.query.hours);
    const since = Number.isFinite(hours) && hours > 0
      ? new Date(Date.now() - Math.min(hours, 24 * 90) * 60 * 60 * 1000).toISOString()
      : undefined;
    return options.db.listKernelEvents(Number(request.params.id), parseLimit(request.query.limit, 200), since);
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/machines/:id/processes", async (request) =>
    options.db.listProcesses(Number(request.params.id), parseLimit(request.query.limit, 200)),
  );
  app.patch<{ Params: { id: string }; Body: { maintenance?: boolean; expectedGpuCount?: number | null } }>("/api/machines/:id", async (request, reply) => {
    const machineId = Number(request.params.id);
    if (!options.db.getMachine(machineId)) {
      return reply.code(404).send({ error: "machine not found" });
    }
    if ("expectedGpuCount" in (request.body ?? {})) {
      const expected = request.body.expectedGpuCount;
      if (expected !== null && (!Number.isInteger(expected) || expected! < 0)) {
        return reply.code(400).send({ error: "expectedGpuCount must be a non-negative integer or null" });
      }
    }
    const updates: { maintenance?: boolean; expectedGpuCount?: number | null } = {};
    if (typeof request.body?.maintenance === "boolean") {
      updates.maintenance = request.body.maintenance;
    }
    if ("expectedGpuCount" in (request.body ?? {})) {
      updates.expectedGpuCount = request.body.expectedGpuCount ?? null;
    }
    return options.db.updateMachineSettings(machineId, updates);
  });
  app.get<{ Querystring: { hours?: string } }>("/api/fleet-history", async (request) => {
    const hours = Number(request.query.hours);
    const windowHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : 24;
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    return options.db.listFleetHistory(since);
  });
  app.get<{ Querystring: { by?: string; key?: string; hours?: string } }>("/api/group-history", async (request, reply) => {
    const by = request.query.by;
    if (by !== "owner" && by !== "location") {
      return reply.code(400).send({ error: "by must be 'owner' or 'location'" });
    }
    const hours = Number(request.query.hours);
    const windowHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : 24;
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    return options.db.listGroupHistory(by, (request.query.key ?? "").trim(), since);
  });
  app.get("/api/gpus", async () => options.db.listGpus());
  app.get<{ Params: { uuid: string }; Querystring: { hours?: string } }>("/api/gpus/:uuid", async (request, reply) => {
    const hours = Number(request.query.hours);
    const since = Number.isFinite(hours) && hours > 0
      ? new Date(Date.now() - Math.min(hours, 24 * 30) * 60 * 60 * 1000).toISOString()
      : undefined;
    const gpu = options.db.getGpu(request.params.uuid, since);
    if (!gpu) {
      return reply.code(404).send({ error: "gpu not found" });
    }
    return gpu;
  });
  app.get<{ Querystring: { limit?: string } }>("/api/poll-runs", async (request) =>
    options.db.listPollRuns(parseLimit(request.query.limit, 50)),
  );
  app.post("/api/poll-runs", async (_request, reply) => {
    try {
      return await scheduler.pollOnce();
    } catch (error) {
      if (error instanceof PollFailedError) {
        return reply.code(500).send({ error: error.message, runId: error.runId });
      }
      throw error;
    }
  });

  const dist = resolve("dist/client");
  if (existsSync(dist)) {
    void app.register(fastifyStatic, {
      root: dist,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not found" });
      }
      reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    scheduler.stop();
  });

  scheduler.start();

  return app;
}

function parseLimit(value: string | undefined, fallback: number, cap = 1000): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, cap) : fallback;
}
