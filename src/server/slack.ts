import { existsSync, readFileSync } from "node:fs";
import { formatDowntime, type RosterEntry } from "./gpuDrops";
import { shortGpuUuid } from "../shared/gpuUuid";

export type SlackChannelConfig = {
  channel: string;
  /** Prepended to drop messages only, so recoveries stay quiet. */
  mention?: string;
};

export type SlackChannelMap = Record<string, SlackChannelConfig>;

export type SlackPost = {
  channel: string;
  text: string;
  threadTs?: string;
  broadcast?: boolean;
};

/** Returns the message timestamp, which anchors the incident thread. */
export type SendSlack = (post: SlackPost) => Promise<string>;

export function loadChannelMap(path: string): SlackChannelMap {
  if (!path || !existsSync(path)) {
    return {};
  }
  return parseChannelMap(readFileSync(path, "utf8"));
}

export function parseChannelMap(text: string): SlackChannelMap {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const map: SlackChannelMap = {};
  for (const [owner, value] of Object.entries(parsed)) {
    // Accept both {"owner": "C123"} and {"owner": {"channel": "C123"}}.
    if (typeof value === "string") {
      if (value.trim()) {
        map[owner.trim()] = { channel: value.trim() };
      }
      continue;
    }
    if (value && typeof value === "object") {
      const entry = value as { channel?: unknown; mention?: unknown };
      if (typeof entry.channel === "string" && entry.channel.trim()) {
        map[owner.trim()] = {
          channel: entry.channel.trim(),
          mention: typeof entry.mention === "string" && entry.mention.trim() ? entry.mention.trim() : undefined,
        };
      }
    }
  }
  return map;
}

/** Owners with no mapping never alert; that is how idle machines stay quiet. */
export function resolveChannel(owner: string, map: SlackChannelMap): SlackChannelConfig | undefined {
  const trimmed = (owner ?? "").trim();
  if (trimmed && map[trimmed]) {
    return map[trimmed];
  }
  const caseInsensitive = Object.keys(map).find((key) => key.toLowerCase() === trimmed.toLowerCase());
  return caseInsensitive ? map[caseInsensitive] : undefined;
}

export function buildDropMessage(input: {
  machineName: string;
  owner: string;
  dropped: RosterEntry[];
  visibleCount: number;
  expectedCount: number;
  wholeMachine: boolean;
  reason?: string;
  mention?: string;
}): string {
  const { machineName, owner, dropped, visibleCount, expectedCount, wholeMachine } = input;
  const headline = wholeMachine
    ? `🔴 ${machineName} (${owner || "unassigned"}) — all ${expectedCount} GPUs not visible`
    : `🔴 ${machineName} (${owner || "unassigned"}) — ${dropped.length} GPU${dropped.length === 1 ? "" : "s"} dropped`;
  const cards = dropped.map((entry) => {
    const slot = entry.gpuIndex === null ? "slot ?" : `slot ${entry.gpuIndex}`;
    return `${entry.gpuType || "GPU"} · ${slot} · ${shortGpuUuid(entry.uuid)}`;
  });
  const footer = [`Now ${visibleCount}/${expectedCount} visible`, input.reason].filter(Boolean).join(" · ");
  return [input.mention, headline, ...cards, footer].filter(Boolean).join("\n");
}

export function buildRecoveryMessage(entry: RosterEntry, droppedAt: string, recoveredAt: string): string {
  const slot = entry.gpuIndex === null ? "slot ?" : `slot ${entry.gpuIndex}`;
  return `🟢 ${slot} (${shortGpuUuid(entry.uuid)}) back after ${formatDowntime(droppedAt, recoveredAt)}`;
}

export function buildAllRecoveredMessage(machineName: string): string {
  return `✅ ${machineName} — all GPUs recovered`;
}

/**
 * Slack answers HTTP 200 with {ok:false, error:"..."} for application errors
 * such as channel_not_found or not_in_channel, so the body must be inspected;
 * checking response.ok alone would silently drop every alert.
 */
export async function postSlack(botToken: string, post: SlackPost): Promise<string> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel: post.channel,
      text: post.text,
      ...(post.threadTs ? { thread_ts: post.threadTs, reply_broadcast: post.broadcast === true } : {}),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; ts?: string; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error(`slack post failed: ${response.status} ${body.error ?? "unknown error"}`);
  }
  return body.ts ?? "";
}
