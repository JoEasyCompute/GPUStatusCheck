import { describe, expect, it } from "vitest";
import {
  parseInstallAgentArgs,
  runAgentAction,
  type AgentInstallTarget,
  type InstallerConfig,
  type RunInstallerCommand,
} from "../src/server/agentInstaller";

const target: AgentInstallTarget = {
  machineId: 7,
  name: "alpha",
  sshHost: "10.0.0.1",
  sshPort: 2222,
};

const config: InstallerConfig = {
  user: "ops",
  keyPath: "/keys/gpu",
  connectTimeoutSeconds: 5,
  force: false,
};

describe("agent installer", () => {
  it("installs the bundled agent with fixed SSH arguments and payload", async () => {
    const fake = commandSequence([
      { code: 0, stdout: "SUDO_OK\n", stderr: "" },
      { code: 0, stdout: "active\n", stderr: "" },
    ]);

    const result = await runAgentAction(target, "install", config, fake.run);

    expect(result).toEqual({ outcome: "succeeded", summary: "installed v0.1.0", output: "active" });
    expect(fake.calls.map((call) => ({ command: call.command, args: call.args, timeoutMs: call.timeoutMs }))).toEqual([
      {
        command: "ssh",
        args: [
          "-i", "/keys/gpu", "-p", "2222", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
          "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", "-o", "StrictHostKeyChecking=accept-new",
          "ops@10.0.0.1",
          "sudo -n true 2>/dev/null && echo SUDO_OK; cat /var/lib/gpucheck-agent/VERSION 2>/dev/null",
        ],
        timeoutMs: 30_000,
      },
      {
        command: "ssh",
        args: [
          "-i", "/keys/gpu", "-p", "2222", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
          "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", "-o", "StrictHostKeyChecking=accept-new",
          "ops@10.0.0.1", "sudo -n sh -s -- 0.1.0",
        ],
        timeoutMs: 120_000,
      },
    ]);
    expect(fake.calls[1]?.input).toContain("systemctl enable --now gpucheck-agent.timer");
  });

  it("skips an equal installed version unless force is enabled", async () => {
    const skipped = commandSequence([{ code: 0, stdout: "SUDO_OK\n0.1.0\n", stderr: "" }]);
    await expect(runAgentAction(target, "install", config, skipped.run)).resolves.toEqual({
      outcome: "skipped",
      summary: "up-to-date (v0.1.0)",
      output: "",
    });
    expect(skipped.calls).toHaveLength(1);

    const forced = commandSequence([
      { code: 0, stdout: "SUDO_OK\n0.1.0\n", stderr: "" },
      { code: 0, stdout: "active\n", stderr: "" },
    ]);
    await expect(runAgentAction(target, "install", { ...config, force: true }, forced.run)).resolves.toMatchObject({
      outcome: "succeeded",
      summary: "upgraded 0.1.0 -> 0.1.0",
    });
    expect(forced.calls).toHaveLength(2);
  });

  it("skips hosts without passwordless sudo", async () => {
    const fake = commandSequence([{ code: 0, stdout: "", stderr: "" }]);

    await expect(runAgentAction(target, "install", config, fake.run)).resolves.toMatchObject({
      outcome: "skipped",
      summary: "no passwordless sudo — stays SSH-poll-only",
    });
  });

  it("uses only the fixed uninstall command and payload", async () => {
    const fake = commandSequence([{ code: 0, stdout: "uninstalled\n", stderr: "" }]);

    await expect(runAgentAction(target, "uninstall", config, fake.run)).resolves.toEqual({
      outcome: "succeeded",
      summary: "uninstalled",
      output: "uninstalled",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args.at(-1)).toBe("sudo -n sh -s --");
    expect(fake.calls[0]?.input).toContain("rm -rf /var/lib/gpucheck-agent");
  });

  it("returns bounded diagnostics for SSH and install failures", async () => {
    const sshFailure = commandSequence([{ code: 255, stdout: "", stderr: "x".repeat(600) }]);
    const result = await runAgentAction(target, "install", config, sshFailure.run);

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("ssh failed");
    expect(result.output).toHaveLength(200);
  });

  it("parses CLI flags without running SSH and rejects missing values", () => {
    expect(parseInstallAgentArgs(["--csv", "fleet.csv", "--only", "alpha", "--uninstall", "--force"])).toEqual({
      csvPath: "fleet.csv",
      only: "alpha",
      action: "uninstall",
      force: true,
      help: false,
    });
    expect(parseInstallAgentArgs(["--help"])).toEqual({ action: "install", force: false, help: true });
    expect(() => parseInstallAgentArgs(["--csv"])).toThrow("--csv requires a value");
    expect(() => parseInstallAgentArgs(["--only"])).toThrow("--only requires a value");
  });
});

function commandSequence(results: Array<{ code: number; stdout: string; stderr: string }>) {
  const calls: Array<{ command: string; args: string[]; input: string; timeoutMs: number }> = [];
  let index = 0;
  const run: RunInstallerCommand = async (command, args, input, timeoutMs) => {
    calls.push({ command, args, input, timeoutMs });
    const result = results[index];
    index += 1;
    if (!result) {
      throw new Error("unexpected installer command");
    }
    return result;
  };
  return { calls, run };
}
