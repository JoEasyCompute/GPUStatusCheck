import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Machine } from "../shared/types";
import type { AppConfig } from "./config";
import type { DashboardDatabase } from "./db";
import { buildSshArgs, parseProbeOutput, spawnWithInput, type ParsedProbe } from "./probe";

let drainScriptCache: string | undefined;

export function buildDrainScript(): string {
  if (drainScriptCache === undefined) {
    const here = dirname(fileURLToPath(import.meta.url));
    drainScriptCache = readFileSync(join(here, "..", "..", "scripts", "agent-drain.sh"), "utf8");
  }
  return drainScriptCache;
}

export type DrainOutput = {
  spoolPresent: boolean;
  hostNow: string;
  agentVersion: string;
  /** BEGIN/END framing intact; when false the batch must be discarded. */
  complete: boolean;
  lines: Array<{ ts: string; b64: string }>;
  malformedLines: number;
};

/** Runs the drain script on the host; separate (longer) timeout than the probe. */
export type DrainAgent = (machine: Machine, watermark: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export function makeDrainAgent(config: AppConfig): DrainAgent {
  return (machine, watermark) => {
    const target = `${config.user}@${machine.sshHost ?? machine.ip}`;
    const args = [
      ...buildSshArgs({
        keyPath: config.keyPath,
        port: machine.sshPort ?? 22,
        connectTimeoutSeconds: config.connectTimeoutSeconds,
        target,
      }),
      "sh -s --",
      // Watermark is an ISO timestamp we produced; quote defensively anyway.
      `'${watermark.replace(/[^0-9TZ:.-]/g, "")}'`,
      String(config.agentDrainMaxLines),
    ];
    return spawnWithInput("ssh", args, buildDrainScript(), config.agentDrainTimeoutSeconds * 1000);
  };
}

export function parseDrainOutput(stdout: string): DrainOutput {
  const output: DrainOutput = {
    spoolPresent: false,
    hostNow: "",
    agentVersion: "",
    complete: false,
    lines: [],
    malformedLines: 0,
  };
  let inLines = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!inLines) {
      if (line.startsWith("HOST_NOW=")) {
        output.hostNow = line.slice("HOST_NOW=".length).trim();
      } else if (line.startsWith("AGENT_SPOOL=")) {
        output.spoolPresent = line.slice("AGENT_SPOOL=".length).trim() === "present";
      } else if (line.startsWith("AGENT_VERSION=")) {
        output.agentVersion = line.slice("AGENT_VERSION=".length).trim();
      } else if (line === "AGENT_LINES_BEGIN") {
        inLines = true;
      }
      continue;
    }
    if (line === "AGENT_LINES_END") {
      output.complete = true;
      break;
    }
    const space = line.indexOf(" ");
    const ts = space > 0 ? line.slice(0, space) : "";
    const b64 = space > 0 ? line.slice(space + 1).trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ts) || b64.length === 0) {
      if (line.trim().length > 0) {
        output.malformedLines += 1;
      }
      continue;
    }
    output.lines.push({ ts, b64 });
  }
  // No spool means no BEGIN/END block was ever emitted; that is a complete,
  // valid answer rather than a truncated one.
  if (!output.spoolPresent && !output.complete) {
    output.complete = true;
  }
  return output;
}

export type IngestResult = {
  ingested: number;
  duplicates: number;
  kernelEvents: number;
  skipped: number;
  watermark: string;
};

const CLOCK_SKEW_TOLERANCE_MS = 120_000;

/**
 * Ingests one drained batch inside a single transaction. Samples become
 * probe_results rows (source='agent') with their real historical timestamps;
 * identity/sighting/drop tables are deliberately never touched — the live
 * poll remains the source of truth for state. Days already folded into
 * gpu_daily_stats are recomputed so backfill is never lost from long-term
 * stats. The watermark only advances when the batch was complete.
 */
export function ingestDrainBatch(
  db: DashboardDatabase,
  machine: Machine,
  output: DrainOutput,
  processArgsMaxChars: number,
  now = new Date(),
): IngestResult {
  const result: IngestResult = { ingested: 0, duplicates: 0, kernelEvents: 0, skipped: output.malformedLines, watermark: "" };
  const maxAcceptable = new Date(now.getTime() + CLOCK_SKEW_TOLERANCE_MS).toISOString();

  type Decoded = { ts: string; parsed: ParsedProbe; kernelEvents: string[] };
  const samples: Decoded[] = [];
  for (const line of output.lines) {
    if (line.ts > maxAcceptable) {
      result.skipped += 1;
      continue;
    }
    let text: string;
    try {
      text = Buffer.from(line.b64, "base64").toString("utf8");
    } catch {
      result.skipped += 1;
      continue;
    }
    if (!text.includes("NVIDIA_SMI_RC=")) {
      result.skipped += 1;
      continue;
    }
    const parsed = parseProbeOutput(text, processArgsMaxChars);
    samples.push({ ts: line.ts, parsed, kernelEvents: extractKernelEventLines(text) });
    if (line.ts > result.watermark) {
      result.watermark = line.ts;
    }
  }
  if (samples.length === 0) {
    return result;
  }

  const rollupWatermark = db.getGpuDailyStatsWatermark();
  const dirtyDays = new Set<string>();
  const dirtyUuids = new Set<string>();

  db.raw.transaction(() => {
    const runId = db.createAgentRun(machine.id!, samples.length, now.toISOString());
    for (const sample of samples) {
      const inserted = db.insertAgentSample(runId, machine.id!, sample.ts, sample.parsed, output.agentVersion);
      if (!inserted) {
        result.duplicates += 1;
        continue;
      }
      result.ingested += 1;
      const day = sample.ts.slice(0, 10);
      if (rollupWatermark && day <= rollupWatermark) {
        dirtyDays.add(day);
        for (const metric of sample.parsed.gpuMetrics) {
          if (metric.uuid) {
            dirtyUuids.add(metric.uuid);
          }
        }
      }
      for (const eventLine of sample.kernelEvents) {
        result.kernelEvents += db.insertAgentKernelEvent(machine.id!, eventLine, now.toISOString());
      }
    }
    if (dirtyDays.size > 0 && dirtyUuids.size > 0) {
      db.recomputeGpuDailyStats([...dirtyDays], [...dirtyUuids]);
    }
  })();

  return result;
}

/** Lines inside the AGENT_KERNEL_EVENTS block; parser-agnostic raw capture. */
function extractKernelEventLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const events: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (collecting) {
      if (line === "__GPUCHECK_EOF__") {
        break;
      }
      if (line.trim()) {
        events.push(line);
      }
      continue;
    }
    if (line === "AGENT_KERNEL_EVENTS<<__GPUCHECK_EOF__") {
      collecting = true;
    }
  }
  return events;
}

/** journalctl short-iso-precise lines start with the event timestamp. */
export function splitKernelEventLine(line: string): { eventAt: string; rest: string } {
  const space = line.indexOf(" ");
  const first = space > 0 ? line.slice(0, space) : "";
  const parsed = Date.parse(first);
  if (Number.isFinite(parsed)) {
    return { eventAt: new Date(parsed).toISOString(), rest: line };
  }
  return { eventAt: "", rest: line };
}
