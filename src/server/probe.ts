import { spawn } from "node:child_process";
import type { GpuMetric, GpuProcess, Machine, ProbeResult } from "../shared/types";

const BLOCK_END = "__GPUCHECK_EOF__";

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
  return String.raw`#!/bin/sh
set -u

machine_name=${"${"}1:-unknown}
machine_ip=${"${"}2:-unknown}
check_logs=${"${"}3:-1}
remote_host=$(hostname 2>/dev/null || echo unknown)
uptime_pretty=$(uptime -p 2>/dev/null || uptime 2>/dev/null || echo unknown)

tmp_out=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_out.%s' "$$")
tmp_err=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_err.%s' "$$")
tmp_log=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_log.%s' "$$")
tmp_pmon=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_pmon.%s' "$$")
tmp_telemetry=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_telemetry.%s' "$$")
tmp_ps=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_ps.%s' "$$")
trap 'rm -f "$tmp_out" "$tmp_err" "$tmp_log" "$tmp_pmon" "$tmp_telemetry" "$tmp_ps"' EXIT INT TERM

nvidia_rc=127
if command -v nvidia-smi >/dev/null 2>&1; then
    if nvidia-smi -L >"$tmp_out" 2>"$tmp_err"; then
        nvidia_rc=0
    else
        nvidia_rc=$?
    fi
else
    printf '%s\n' "nvidia-smi not found" >"$tmp_err"
fi

gpu_count=0
if [ -s "$tmp_out" ]; then
    gpu_count=$(grep -c '^GPU ' "$tmp_out" 2>/dev/null || printf '0')
fi

gpu_type=""
if [ -s "$tmp_out" ]; then
    gpu_type=$(awk '
        /^GPU / {
            line = $0
            sub(/^GPU [0-9]+: /, "", line)
            sub(/ \(UUID:.*/, "", line)
            print line
            exit
        }
    ' "$tmp_out")
fi

gpu_jobs=""
if [ "$gpu_count" -gt 0 ] 2>/dev/null && command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi pmon -c 1 >"$tmp_pmon" 2>/dev/null || true
    gpu_jobs=$(awk -v count="$gpu_count" '
        BEGIN { for (idx = 0; idx < count; idx++) busy[idx] = 0 }
        $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { busy[$1] = 1 }
        END { for (idx = 0; idx < count; idx++) printf "%s", busy[idx] ? "D" : "x" }
    ' "$tmp_pmon")
    pids=$(awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {print $2}' "$tmp_pmon" | sort -u | paste -sd, -)
    if [ -n "$pids" ] && command -v ps >/dev/null 2>&1; then
        ps -p "$pids" -o pid=,user=,etime=,comm=,args= >"$tmp_ps" 2>/dev/null || true
    fi
fi

gpu_power_w=""
gpu_avg_temp_c=""
if [ "$gpu_count" -gt 0 ] 2>/dev/null && command -v nvidia-smi >/dev/null 2>&1; then
    if nvidia-smi --query-gpu=index,pci.bus_id,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.current.graphics,clocks.current.memory --format=csv,noheader,nounits >"$tmp_telemetry" 2>/dev/null; then
        telemetry=$(awk -F',' '
            function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
            {
                power = trim($6); temp = trim($5)
                if (power ~ /^[0-9]+([.][0-9]+)?$/) { power_total += power; power_seen = 1 }
                if (temp ~ /^[0-9]+([.][0-9]+)?$/) { temp_total += temp; temp_count += 1 }
            }
            END {
                if (power_seen) printf "%.1f", power_total
                printf "|"
                if (temp_count > 0) printf "%.1f", temp_total / temp_count
            }
        ' "$tmp_telemetry")
        gpu_power_w=${"${"}telemetry%%|*}
        gpu_avg_temp_c=${"${"}telemetry#*|}
    fi
fi

if [ "$check_logs" = "1" ]; then
    if command -v journalctl >/dev/null 2>&1; then
        journalctl -k -b --no-pager -n 500 >"$tmp_log" 2>/dev/null || true
    elif command -v dmesg >/dev/null 2>&1; then
        dmesg >"$tmp_log" 2>/dev/null || true
    else
        : >"$tmp_log"
    fi
else
    : >"$tmp_log"
fi

kernel_hits=$(grep -Ei 'fallen off the bus|Xid.*79|NVRM: Xid|NVRM.*fallen off the bus|GPU has fallen off the bus' "$tmp_log" 2>/dev/null || true)

echo "REMOTE_HOST=$remote_host"
echo "UPTIME_PRETTY=$uptime_pretty"
echo "NVIDIA_SMI_RC=$nvidia_rc"
echo "GPU_COUNT=$gpu_count"
echo "GPU_TYPE=$gpu_type"
echo "GPU_JOBS=$gpu_jobs"
echo "GPU_POWER_W=$gpu_power_w"
echo "GPU_AVG_TEMP_C=$gpu_avg_temp_c"
if [ -n "$kernel_hits" ]; then echo "BUS_OFF=1"; else echo "BUS_OFF=0"; fi

printf 'NVIDIA_SMI_OUTPUT<<__GPUCHECK_EOF__\n'
cat "$tmp_out" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'NVIDIA_SMI_ERROR<<__GPUCHECK_EOF__\n'
cat "$tmp_err" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'KERNEL_HITS<<__GPUCHECK_EOF__\n'
printf '%s\n' "$kernel_hits" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'GPU_METRICS<<__GPUCHECK_EOF__\n'
cat "$tmp_telemetry" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'PMON_OUTPUT<<__GPUCHECK_EOF__\n'
cat "$tmp_pmon" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'PS_OUTPUT<<__GPUCHECK_EOF__\n'
cat "$tmp_ps" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
`;
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
