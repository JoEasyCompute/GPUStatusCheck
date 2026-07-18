export type AlertInput = {
  name: string;
  ip: string;
  status: string;
  reason: string;
};

export type BuiltAlerts = {
  lines: string[];
  nextStates: Record<string, string>;
};

const PROBLEM_STATUSES = new Set(["degraded", "ssh_failed"]);

export function buildAlerts(
  results: AlertInput[],
  previous: Record<string, string>,
  notifyRecovery: boolean,
): BuiltAlerts {
  const lines: string[] = [];
  const nextStates: Record<string, string> = {};

  for (const result of results) {
    nextStates[result.name] = result.status;
    const previousStatus = previous[result.name];

    if (result.status === "ok") {
      if (notifyRecovery && previousStatus && PROBLEM_STATUSES.has(previousStatus)) {
        lines.push(`• ${result.name} (${result.ip}) RECOVERED: ${previousStatus} → ok`);
      }
      continue;
    }

    if (previousStatus !== result.status) {
      const reason = result.reason || "unknown issue";
      const label = result.status === "ssh_failed" ? "SSH FAILED" : "DEGRADED";
      lines.push(`• ${result.name} (${result.ip}) ${label}: ${reason}`);
    }
  }

  return { lines, nextStates };
}

export function formatAlertMessage(lines: string[], ok: number, degraded: number, sshFailed: number): string {
  return [
    "GPU status alert",
    `Summary: ok=${ok} degraded=${degraded} ssh_failed=${sshFailed}`,
    "",
    ...lines,
    "",
    "Triggered by the latest dashboard poll.",
  ].join("\n");
}

export function splitMessage(message: string, limit = 3800): string[] {
  if (message.length <= limit) {
    return [message];
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of message.split("\n")) {
    // A single line longer than the limit (e.g. a huge ssh error) must be
    // hard-split, or the chunk would exceed Telegram's message size cap.
    const parts: string[] = [];
    for (let i = 0; i < Math.max(1, Math.ceil(line.length / limit)); i += 1) {
      parts.push(line.slice(i * limit, (i + 1) * limit));
    }
    for (const part of parts) {
      const addition = part.length + 1;
      if (current.length > 0 && size + addition > limit) {
        chunks.push(current.join("\n"));
        current = [part];
        size = addition;
      } else {
        current.push(part);
        size += addition;
      }
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

export async function sendTelegramMessage(botToken: string, chatId: string, message: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: "true",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`telegram send failed: ${response.status} ${body.slice(0, 200)}`);
  }
}
