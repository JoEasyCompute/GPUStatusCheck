import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAction } from "../shared/types";
import { buildSshArgs, spawnWithInput } from "./probe";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
const agentVersion = readFileSync(join(scriptsDir, "agent", "VERSION"), "utf8").trim();
const outputLimit = 200;

export type AgentInstallTarget = { machineId: number; name: string; sshHost: string; sshPort: number };
export type AgentInstallResult = { outcome: "succeeded" | "skipped" | "failed"; summary: string; output: string };
export type InstallerConfig = { user: string; keyPath: string; connectTimeoutSeconds: number; force?: boolean };
export type RunInstallerCommand = (
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;
export type InstallAgentCliOptions = { csvPath?: string; only?: string; action: AgentAction; force: boolean; help: boolean };

export function parseInstallAgentArgs(argv: string[]): InstallAgentCliOptions {
  const options: InstallAgentCliOptions = { action: "install", force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--uninstall") {
      options.action = "uninstall";
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--csv" || argument === "--only") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--csv") options.csvPath = value;
      else options.only = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export async function runAgentAction(
  target: AgentInstallTarget,
  action: AgentAction,
  config: InstallerConfig,
  runCommand: RunInstallerCommand = spawnWithInput,
): Promise<AgentInstallResult> {
  try {
    if (action === "uninstall") {
      const completed = await runSsh(target, config, "sudo -n sh -s --", uninstallPayload, 60_000, runCommand);
      const output = diagnostic(completed);
      return completed.code === 0
        ? { outcome: "succeeded", summary: "uninstalled", output }
        : { outcome: "failed", summary: "uninstall failed", output };
    }

    const check = await runSsh(
      target,
      config,
      "sudo -n true 2>/dev/null && echo SUDO_OK; cat /var/lib/gpucheck-agent/VERSION 2>/dev/null",
      "",
      30_000,
      runCommand,
    );
    if (check.code !== 0) return { outcome: "failed", summary: "ssh failed", output: diagnostic(check) };
    const lines = check.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.includes("SUDO_OK")) {
      return { outcome: "skipped", summary: "no passwordless sudo — stays SSH-poll-only", output: diagnostic(check) };
    }
    const installed = lines.find((line) => line !== "SUDO_OK") ?? "";
    if (installed === agentVersion && !config.force) {
      return { outcome: "skipped", summary: `up-to-date (v${agentVersion})`, output: "" };
    }

    const completed = await runSsh(target, config, `sudo -n sh -s -- ${agentVersion}`, installPayload(), 120_000, runCommand);
    const output = diagnostic(completed);
    if (completed.code !== 0 || !completed.stdout.includes("active")) {
      return { outcome: "failed", summary: "install failed", output };
    }
    return {
      outcome: "succeeded",
      summary: installed ? `upgraded ${installed} -> ${agentVersion}` : `installed v${agentVersion}`,
      output,
    };
  } catch (error) {
    return { outcome: "failed", summary: "installer error", output: String(error instanceof Error ? error.message : error).slice(0, outputLimit) };
  }
}

export function bundledAgentVersion(): string {
  return agentVersion;
}

async function runSsh(
  target: AgentInstallTarget,
  config: InstallerConfig,
  remote: string,
  input: string,
  timeoutMs: number,
  runCommand: RunInstallerCommand,
) {
  const args = [
    ...buildSshArgs({
      keyPath: config.keyPath,
      port: target.sshPort,
      connectTimeoutSeconds: config.connectTimeoutSeconds,
      target: `${config.user}@${target.sshHost}`,
    }),
    remote,
  ];
  return runCommand("ssh", args, input, timeoutMs);
}

function diagnostic(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout).trim().slice(0, outputLimit);
}

function installPayload(): string {
  const probeScript = readFileSync(join(scriptsDir, "remote-probe.sh"), "utf8");
  const agentScript = readFileSync(join(scriptsDir, "agent", "gpucheck-agent.sh"), "utf8");
  const serviceUnit = readFileSync(join(scriptsDir, "agent", "gpucheck-agent.service"), "utf8");
  const timerUnit = readFileSync(join(scriptsDir, "agent", "gpucheck-agent.timer"), "utf8");
  return `set -eu
version="$1"
mkdir -p /var/lib/gpucheck-agent/spool
cat > /usr/local/bin/gpucheck-probe.sh <<'GPUCHECK_INSTALL_PROBE'
${probeScript}
GPUCHECK_INSTALL_PROBE
cat > /usr/local/bin/gpucheck-agent.sh <<'GPUCHECK_INSTALL_AGENT'
${agentScript}
GPUCHECK_INSTALL_AGENT
chmod 755 /usr/local/bin/gpucheck-probe.sh /usr/local/bin/gpucheck-agent.sh
cat > /etc/systemd/system/gpucheck-agent.service <<'GPUCHECK_INSTALL_SERVICE'
${serviceUnit}
GPUCHECK_INSTALL_SERVICE
cat > /etc/systemd/system/gpucheck-agent.timer <<'GPUCHECK_INSTALL_TIMER'
${timerUnit}
GPUCHECK_INSTALL_TIMER
printf '%s\n' "$version" > /var/lib/gpucheck-agent/VERSION
systemctl daemon-reload
systemctl enable --now gpucheck-agent.timer
systemctl is-active gpucheck-agent.timer
`;
}

const uninstallPayload = `set -u
systemctl disable --now gpucheck-agent.timer 2>/dev/null || true
rm -f /etc/systemd/system/gpucheck-agent.service /etc/systemd/system/gpucheck-agent.timer
rm -f /usr/local/bin/gpucheck-agent.sh /usr/local/bin/gpucheck-probe.sh
rm -rf /var/lib/gpucheck-agent
systemctl daemon-reload
echo uninstalled
`;
