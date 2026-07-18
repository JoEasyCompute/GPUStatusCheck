import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GpuMetric, GpuProcess, Machine, ProbeResult } from "../shared/types";

const BLOCK_END = "__GPUCHECK_EOF__";

let remoteScriptCache: string | undefined;

export type ParsedProbe = {
  remoteHost: string;
  uptime: string;
  nvidiaSmiRc: number | null;
  gpuCount: number | null;
  gpuType: string;
  gpuJobs: string;
  gpuPowerW: string;
  gpuAvgTempC: string;
  busOffSuspected: boolean;
  nvidiaSmiOutput: string;
  nvidiaSmiError: string;
  kernelHits: string;
  processes: GpuProcess[];
  gpuMetrics: GpuMetric[];
};

export type RunProbeOptions = {
  user: string;
  keyPath: string;
  connectTimeoutSeconds: number;
  probeTimeoutSeconds: number;
  checkLogs: boolean;
  processArgsMaxChars: number;
};

export function parseProbeOutput(stdout: string, processArgsMaxChars: number): ParsedProbe {
  const nvidiaSmiRc = scalar(stdout, "NVIDIA_SMI_RC");
  const gpuCount = scalar(stdout, "GPU_COUNT");
  const kernelHits = block(stdout, "KERNEL_HITS");
  const busOff = scalar(stdout, "BUS_OFF");
  const parsedGpuCount = gpuCount && /^\d+$/.test(gpuCount) ? Number(gpuCount) : null;
  const parsedGpuJobs = scalar(stdout, "GPU_JOBS") ?? "";
  const busOffSuspected = busOff === "1" || kernelHits.length > 0;

  return {
    remoteHost: scalar(stdout, "REMOTE_HOST") ?? "",
    uptime: scalar(stdout, "UPTIME_PRETTY") ?? "",
    nvidiaSmiRc: nvidiaSmiRc && /^\d+$/.test(nvidiaSmiRc) ? Number(nvidiaSmiRc) : null,
    gpuCount: parsedGpuCount,
    gpuType: normalizeGpuType(scalar(stdout, "GPU_TYPE") ?? ""),
    gpuJobs: normalizeGpuJobs(parsedGpuJobs, parsedGpuCount, busOffSuspected),
    gpuPowerW: scalar(stdout, "GPU_POWER_W") ?? "",
    gpuAvgTempC: scalar(stdout, "GPU_AVG_TEMP_C") ?? "",
    busOffSuspected,
    nvidiaSmiOutput: block(stdout, "NVIDIA_SMI_OUTPUT"),
    nvidiaSmiError: block(stdout, "NVIDIA_SMI_ERROR"),
    kernelHits,
    processes: parseGpuProcesses(block(stdout, "PMON_OUTPUT"), block(stdout, "PS_OUTPUT"), processArgsMaxChars),
    gpuMetrics: parseGpuMetrics(block(stdout, "GPU_METRICS")),
  };
}

function normalizeGpuJobs(gpuJobs: string, gpuCount: number | null, busOffSuspected: boolean): string {
  if (!busOffSuspected) {
    return gpuJobs;
  }
  const width = gpuCount && gpuCount > 0 ? gpuCount : gpuJobs.length;
  return "E".repeat(Math.max(1, width));
}

function normalizeGpuType(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.at(-1) ?? "";
}

export function parseGpuProcesses(pmonOutput: string, psOutput: string, maxArgsChars: number): GpuProcess[] {
  const psByPid = parsePsOutput(psOutput, maxArgsChars);
  const processes: GpuProcess[] = [];

  for (const rawLine of pmonOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const parts = line.split(/\s+/);
    const gpuIndex = Number(parts[0]);
    const pid = Number(parts[1]);
    if (!Number.isInteger(gpuIndex) || !Number.isInteger(pid)) {
      continue;
    }

    const enriched = psByPid.get(pid);
    processes.push({
      gpuIndex,
      pid,
      processType: cleanToken(parts[2]),
      smUtil: numericOrNull(parts[3]),
      memUtil: numericOrNull(parts[4]),
      encUtil: numericOrNull(parts[5]),
      decUtil: numericOrNull(parts[6]),
      command: cleanToken(parts.slice(7).join(" ")),
      user: enriched?.user,
      elapsed: enriched?.elapsed,
      processName: enriched?.processName,
      commandLine: enriched?.commandLine,
    });
  }

  return processes;
}

export function parseGpuMetrics(metricsOutput: string): GpuMetric[] {
  const metrics: GpuMetric[] = [];
  for (const rawLine of metricsOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(",").map((part) => part.trim());
    const gpuIndex = Number(parts[0]);
    if (!Number.isInteger(gpuIndex)) {
      continue;
    }
    metrics.push({
      gpuIndex,
      pciBusId: cleanToken(parts[1]),
      gpuUtil: numericOrNull(parts[2]),
      memUtil: numericOrNull(parts[3]),
      tempC: numericOrNull(parts[4]),
      powerW: numericOrNull(parts[5]),
      powerLimitW: numericOrNull(parts[6]),
      graphicsClockMhz: numericOrNull(parts[7]),
      memoryClockMhz: numericOrNull(parts[8]),
    });
  }
  return metrics;
}

export async function runProbe(machine: Machine, options: RunProbeOptions): Promise<ProbeResult> {
  const start = Date.now();
  const sshHost = machine.sshHost ?? machine.ip;
  const sshPort = machine.sshPort ?? 22;
  const sshTarget = `${options.user}@${sshHost}`;
  const args = [
    "-i",
    options.keyPath,
    "-p",
    String(sshPort),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${options.connectTimeoutSeconds}`,
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=1",
    "-o",
    "StrictHostKeyChecking=accept-new",
    sshTarget,
    "sh -s --",
    machine.name,
    machine.ip,
    options.checkLogs ? "1" : "0",
  ];

  const resultBase = {
    name: machine.name,
    ip: machine.ip,
    platform: machine.platform,
    owner: machine.owner,
    commissionDate: machine.commissionDate,
  };

  try {
    const completed = await spawnWithInput("ssh", args, buildRemoteScript(), options.probeTimeoutSeconds * 1000);
    if (completed.code !== 0) {
      return {
        ...resultBase,
        sshOk: false,
        sshError: (completed.stderr || completed.stdout).trim(),
        status: "ssh_failed",
        durationMs: Date.now() - start,
      };
    }

    const parsed = parseProbeOutput(completed.stdout, options.processArgsMaxChars);
    const reasons: string[] = [];
    if (parsed.busOffSuspected) {
      reasons.push("kernel/log indicators");
    }
    if (parsed.nvidiaSmiRc !== null && parsed.nvidiaSmiRc !== 0) {
      reasons.push(`nvidia-smi rc=${parsed.nvidiaSmiRc}`);
    }
    if (parsed.nvidiaSmiRc === 0 && parsed.gpuCount !== null && parsed.gpuCount < 1) {
      reasons.push("nvidia-smi reported zero GPUs");
    }

    return {
      ...resultBase,
      sshOk: true,
      remoteHost: parsed.remoteHost,
      uptime: parsed.uptime,
      nvidiaSmiRc: parsed.nvidiaSmiRc,
      gpuCount: parsed.gpuCount,
      gpuType: parsed.gpuType,
      gpuJobs: parsed.gpuJobs,
      gpuPowerW: parsed.gpuPowerW,
      gpuAvgTempC: parsed.gpuAvgTempC,
      busOffSuspected: parsed.busOffSuspected,
      busOffReason: reasons.join("; "),
      nvidiaSmiOutput: parsed.nvidiaSmiOutput,
      nvidiaSmiError: parsed.nvidiaSmiError,
      kernelHits: parsed.kernelHits,
      status: reasons.length > 0 ? "degraded" : "ok",
      durationMs: Date.now() - start,
      processes: parsed.processes,
      gpuMetrics: parsed.gpuMetrics,
    };
  } catch (error) {
    return {
      ...resultBase,
      sshOk: false,
      sshError: error instanceof Error ? error.message : String(error),
      status: "ssh_failed",
      durationMs: Date.now() - start,
    };
  }
}

export function buildRemoteScript(): string {
  if (remoteScriptCache === undefined) {
    const here = dirname(fileURLToPath(import.meta.url));
    remoteScriptCache = readFileSync(join(here, "..", "..", "scripts", "remote-probe.sh"), "utf8");
  }
  return remoteScriptCache;
}

function parsePsOutput(psOutput: string, maxArgsChars: number): Map<number, Pick<GpuProcess, "user" | "elapsed" | "processName" | "commandLine">> {
  const rows = new Map<number, Pick<GpuProcess, "user" | "elapsed" | "processName" | "commandLine">>();
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid)) {
      continue;
    }
    const commandLine = parts.slice(4).join(" ");
    rows.set(pid, {
      user: parts[1],
      elapsed: parts[2],
      processName: parts[3],
      commandLine: commandLine.slice(0, maxArgsChars),
    });
  }
  return rows;
}

function scalar(text: string, key: string): string | undefined {
  const prefix = `${key}=`;
  return text
    .split(/\r?\n/)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function block(text: string, key: string): string {
  const start = `${key}<<${BLOCK_END}`;
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (collecting) {
      if (line === BLOCK_END) {
        break;
      }
      output.push(line);
      continue;
    }
    if (line === start) {
      collecting = true;
    }
  }
  return output.join("\n").trim();
}

function numericOrNull(value: string | undefined): number | null {
  if (value === undefined || value === "-" || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanToken(value: string | undefined): string {
  return value === undefined || value === "-" ? "" : value;
}

function spawnWithInput(command: string, args: string[], input: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`probe timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    // ssh can exit before reading stdin (refused connection, bad key); without a
    // handler the resulting EPIPE stream error would crash the whole process.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
