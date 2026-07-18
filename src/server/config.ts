import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AppConfig = {
  machinesPath: string;
  dbPath: string;
  envPath: string;
  user: string;
  keyPath: string;
  connectTimeoutSeconds: number;
  probeTimeoutSeconds: number;
  jobs: number;
  pollIntervalSeconds: number;
  skipLogs: boolean;
  processArgsMaxChars: number;
  pollOnStartup: boolean;
  retentionDays: number;
  telegramBotToken: string;
  telegramChatId: string;
  notifyRecovery: boolean;
  host: string;
  port: number;
};

export function loadConfig(env = process.env): AppConfig {
  const envPath = env.GPUCHECK_ENV_FILE || ".env";
  const envFile = readEnvFile(envPath);
  const value = (name: string) => env[name] || envFile[name];

  return {
    machinesPath: value("GPUCHECK_MACHINES") || "machines.csv",
    dbPath: value("GPUCHECK_DB") || "data/gpu-status.sqlite",
    envPath,
    user: value("GPUCHECK_USER") || "ezc",
    keyPath: value("GPUCHECK_KEY") || "~/.ssh/EZC-HydraHost",
    connectTimeoutSeconds: numberEnv(value("GPUCHECK_TIMEOUT"), 10),
    probeTimeoutSeconds: numberEnv(value("GPUCHECK_PROBE_TIMEOUT"), 60),
    jobs: numberEnv(value("GPUCHECK_JOBS"), 8),
    pollIntervalSeconds: numberEnv(value("GPUCHECK_POLL_INTERVAL_SECONDS"), 300),
    skipLogs: boolEnv(value("GPUCHECK_SKIP_LOGS"), false),
    processArgsMaxChars: numberEnv(value("GPUCHECK_PROCESS_ARGS_MAX_CHARS"), 512),
    pollOnStartup: !boolEnv(value("GPUCHECK_DISABLE_STARTUP_POLL"), false),
    retentionDays: numberEnv(value("GPUCHECK_RETENTION_DAYS"), 30),
    telegramBotToken: value("TELEGRAM_BOT_TOKEN") || "",
    telegramChatId: value("TELEGRAM_CHAT_ID") || "",
    notifyRecovery: boolEnv(value("GPUCHECK_NOTIFY_RECOVERY"), false),
    host: value("GPUCHECK_HOST") || "127.0.0.1",
    port: numberEnv(value("PORT"), 4100),
  };
}

export function writeEnvSettings(envPath: string, updates: Record<string, string | number>): void {
  if (envPath !== ".env") {
    mkdirSync(dirname(envPath), { recursive: true });
  }
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    for (const [key, rawValue] of Object.entries(updates)) {
      const pattern = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegExp(key)}\\s*=`);
      const match = line.match(pattern);
      if (match) {
        seen.add(key);
        return `${match[1]}${key}=${formatEnvValue(String(rawValue))}`;
      }
    }
    return line;
  });

  for (const [key, rawValue] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${formatEnvValue(String(rawValue))}`);
    }
  }

  writeFileSync(envPath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`);
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }
    const equalIndex = line.indexOf("=");
    if (equalIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "\"" || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
