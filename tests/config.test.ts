import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";

describe("configuration", () => {
  it("defaults SSH failure reminders to six hours and allows disabling them", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "gpu-config-reminders-")), "missing.env");
    expect(loadConfig({ GPUCHECK_ENV_FILE: envPath }).sshFailureReminderHours).toBe(6);
    expect(loadConfig({ GPUCHECK_ENV_FILE: envPath, GPUCHECK_SSH_FAILURE_REMINDER_HOURS: "0" }).sshFailureReminderHours).toBe(0);
    expect(loadConfig({ GPUCHECK_ENV_FILE: envPath, GPUCHECK_SSH_FAILURE_REMINDER_HOURS: "12" }).sshFailureReminderHours).toBe(12);
    expect(loadConfig({ GPUCHECK_ENV_FILE: envPath, GPUCHECK_SSH_FAILURE_REMINDER_HOURS: "-1" }).sshFailureReminderHours).toBe(0);
  });

  it("allows selecting the full fleet for a bounded agent operation", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "gpu-config-agent-batch-")), "missing.env");
    expect(loadConfig({ GPUCHECK_ENV_FILE: envPath }).agentMaxBatch).toBe(250);
    expect(loadConfig({ GPUCHECK_ENV_FILE: envPath, GPUCHECK_AGENT_MAX_BATCH: "174" }).agentMaxBatch).toBe(174);
  });
});
