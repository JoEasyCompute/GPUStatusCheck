import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EditableRuntimeConfig, RuntimeConfig } from "../shared/types";
import type { AppConfig } from "./config";
import { writeEnvSettings } from "./config";
import type { DashboardDatabase } from "./db";
import { PollScheduler, type ProbeMachine } from "./scheduler";

export type BuildAppOptions = {
  db: DashboardDatabase;
  config: AppConfig;
  probeMachine?: ProbeMachine;
};

export function buildApp(options: BuildAppOptions) {
  const app = fastify({ logger: false });
  const scheduler = new PollScheduler(options.db, options.config, options.probeMachine);
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
    port: options.config.port,
  });

  app.get("/api/health", async () => ({ ok: true }));
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

    writeEnvSettings(options.config.envPath, {
      GPUCHECK_MACHINES: machinesPath,
      GPUCHECK_POLL_INTERVAL_SECONDS: pollIntervalSeconds,
    });
    scheduler.updateConfig({ machinesPath, pollIntervalSeconds });
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
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/machines/:id/history", async (request) =>
    options.db.listHistory(Number(request.params.id), parseLimit(request.query.limit, 200)),
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/machines/:id/processes", async (request) =>
    options.db.listProcesses(Number(request.params.id), parseLimit(request.query.limit, 200)),
  );
  app.get<{ Querystring: { limit?: string } }>("/api/poll-runs", async (request) =>
    options.db.listPollRuns(parseLimit(request.query.limit, 50)),
  );
  app.post("/api/poll-runs", async () => scheduler.pollOnce());

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

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : fallback;
}
