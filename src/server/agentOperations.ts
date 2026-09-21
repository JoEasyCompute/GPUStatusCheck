import type { AgentAction } from "../shared/types";
import { runAgentAction, type AgentInstallResult, type AgentInstallTarget, type InstallerConfig } from "./agentInstaller";
import type { AppConfig } from "./config";
import type { DashboardDatabase } from "./db";

export type RunAgentAction = (
  target: AgentInstallTarget,
  action: AgentAction,
  config: InstallerConfig,
) => Promise<AgentInstallResult>;

export class AgentOperationRunner {
  private readonly runningOperations = new Set<number>();

  constructor(
    private readonly db: DashboardDatabase,
    private readonly config: AppConfig,
    private readonly runAction: RunAgentAction = runAgentAction,
  ) {}

  start(operationId: number): void {
    if (this.runningOperations.has(operationId)) return;
    this.runningOperations.add(operationId);
    void this.run(operationId).finally(() => {
      this.runningOperations.delete(operationId);
    });
  }

  recoverInterrupted(): number {
    return this.db.interruptAgentOperations();
  }

  isMachineBusy(machineId: number): boolean {
    const row = this.db.raw.prepare(`
      SELECT 1 AS busy FROM agent_operation_items
      WHERE machine_id = ? AND status IN ('queued', 'running') LIMIT 1
    `).get(machineId) as { busy: number } | undefined;
    return row?.busy === 1;
  }

  private async run(operationId: number): Promise<void> {
    const operation = this.db.getAgentOperation(operationId);
    if (!operation || operation.status !== "queued") return;
    this.db.markAgentOperationRunning(operationId);
    let index = 0;
    const items = operation.items.filter((item) => item.status === "queued");
    const workers = Array.from({ length: Math.min(Math.max(1, this.config.agentInstallJobs), items.length) }, async () => {
      while (index < items.length) {
        const item = items[index]!;
        index += 1;
        await this.runItem(operation.action, item.id, item.machineId);
      }
    });
    await Promise.allSettled(workers);
    this.db.finalizeAgentOperation(operationId);
    this.db.pruneAgentOperations(this.config.agentOperationRetentionDays);
  }

  private async runItem(action: AgentAction, itemId: number, machineId: number): Promise<void> {
    this.db.markAgentOperationItemRunning(itemId);
    let status: "succeeded" | "skipped" | "failed" = "failed";
    let summary = "installer error";
    let output = "";
    try {
      const machine = this.db.getMachine(machineId);
      if (!machine || machine.active === false) {
        summary = "machine is no longer active";
      } else {
        const result = await this.runAction({
          machineId,
          name: machine.name,
          sshHost: machine.sshHost ?? machine.ip,
          sshPort: machine.sshPort ?? 22,
        }, action, {
          user: this.config.user,
          keyPath: this.config.keyPath,
          connectTimeoutSeconds: this.config.connectTimeoutSeconds,
        });
        status = result.outcome;
        summary = result.summary;
        output = result.output;
      }
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    } finally {
      const secrets = [this.config.adminApiKey, this.config.keyPath].filter(Boolean);
      this.db.finishAgentOperationItem(
        itemId,
        status,
        sanitizeAgentOutput(summary, secrets, Math.min(500, this.config.agentOutputMaxChars)),
        sanitizeAgentOutput(output, secrets, this.config.agentOutputMaxChars),
      );
    }
  }
}

export function sanitizeAgentOutput(text: string, secrets: string[], maxChars: number): string {
  let sanitized = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized.slice(0, Math.max(0, maxChars));
}
