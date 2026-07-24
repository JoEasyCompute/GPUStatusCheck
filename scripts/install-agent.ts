/**
 * Installs (or upgrades / uninstalls) the on-host GPUStatusCheck agent over
 * SSH: `npm run agent:install -- [--csv <path>] [--only <name-or-ip>]
 * [--uninstall] [--force]`.
 *
 * Requires passwordless sudo on the host; hosts without it are skipped and
 * simply stay on the pure SSH-poll workflow (the agent is optional per host
 * by design). Idempotent: hosts already on the bundled VERSION are left
 * untouched unless --force.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/server/config";
import { readInventoryFromFile } from "../src/server/inventory";
import { buildSshArgs, spawnWithInput } from "../src/server/probe";
import type { Machine } from "../src/shared/types";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_VERSION = readFileSync(join(here, "agent", "VERSION"), "utf8").trim();

type HostResult = { name: string; outcome: string };

function payloadInstall(): string {
  const probeScript = readFileSync(join(here, "remote-probe.sh"), "utf8");
  const agentScript = readFileSync(join(here, "agent", "gpucheck-agent.sh"), "utf8");
  const serviceUnit = readFileSync(join(here, "agent", "gpucheck-agent.service"), "utf8");
  const timerUnit = readFileSync(join(here, "agent", "gpucheck-agent.timer"), "utf8");
  // Quoted heredoc delimiters stop the remote shell expanding anything inside
  // the embedded scripts. The delimiters must not appear in the payload bodies
  // (the scripts only use __GPUCHECK_EOF__).
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
printf '%s\\n' "$version" > /var/lib/gpucheck-agent/VERSION
systemctl daemon-reload
systemctl enable --now gpucheck-agent.timer
systemctl is-active gpucheck-agent.timer
`;
}

const payloadUninstall = `set -u
systemctl disable --now gpucheck-agent.timer 2>/dev/null || true
rm -f /etc/systemd/system/gpucheck-agent.service /etc/systemd/system/gpucheck-agent.timer
rm -f /usr/local/bin/gpucheck-agent.sh /usr/local/bin/gpucheck-probe.sh
rm -rf /var/lib/gpucheck-agent
systemctl daemon-reload
echo uninstalled
`;

async function ssh(machine: Machine, config: ReturnType<typeof loadConfig>, remote: string, input: string, timeoutMs: number) {
  const target = `${config.user}@${machine.sshHost ?? machine.ip}`;
  const args = [
    ...buildSshArgs({
      keyPath: config.keyPath,
      port: machine.sshPort ?? 22,
      connectTimeoutSeconds: config.connectTimeoutSeconds,
      target,
    }),
    remote,
  ];
  return spawnWithInput("ssh", args, input, timeoutMs);
}

async function processHost(machine: Machine, config: ReturnType<typeof loadConfig>, options: { uninstall: boolean; force: boolean }): Promise<HostResult> {
  try {
    if (options.uninstall) {
      const result = await ssh(machine, config, "sudo -n sh -s --", payloadUninstall, 60_000);
      return { name: machine.name, outcome: result.code === 0 ? "uninstalled" : `uninstall failed: ${(result.stderr || result.stdout).trim().slice(0, 80)}` };
    }

    const sudoCheck = await ssh(machine, config, "sudo -n true 2>/dev/null && echo SUDO_OK; cat /var/lib/gpucheck-agent/VERSION 2>/dev/null", "", 30_000);
    if (sudoCheck.code !== 0) {
      return { name: machine.name, outcome: `ssh failed: ${(sudoCheck.stderr || sudoCheck.stdout).trim().slice(0, 80)}` };
    }
    const lines = sudoCheck.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.includes("SUDO_OK")) {
      return { name: machine.name, outcome: "skipped (no passwordless sudo) — stays SSH-poll-only" };
    }
    const installed = lines.find((line) => line !== "SUDO_OK") ?? "";
    if (installed === AGENT_VERSION && !options.force) {
      return { name: machine.name, outcome: `up-to-date (v${AGENT_VERSION})` };
    }

    const install = await ssh(machine, config, `sudo -n sh -s -- ${AGENT_VERSION}`, payloadInstall(), 120_000);
    if (install.code !== 0 || !install.stdout.includes("active")) {
      return { name: machine.name, outcome: `install failed: ${(install.stderr || install.stdout).trim().slice(0, 100)}` };
    }
    return { name: machine.name, outcome: installed ? `upgraded ${installed} -> ${AGENT_VERSION}` : `installed v${AGENT_VERSION}` };
  } catch (error) {
    return { name: machine.name, outcome: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const config = loadConfig();
  const csvPath = value("--csv") ?? config.machinesPath;
  const only = value("--only");
  const options = { uninstall: flag("--uninstall"), force: flag("--force") };

  let machines = readInventoryFromFile(csvPath);
  if (only) {
    machines = machines.filter((machine) => machine.name === only || machine.ip.startsWith(only));
    if (machines.length === 0) {
      console.error(`no machine matching "${only}" in ${csvPath}`);
      process.exit(1);
    }
  }

  console.log(`${options.uninstall ? "Uninstalling" : "Installing"} agent v${AGENT_VERSION} on ${machines.length} host(s) from ${csvPath}\n`);

  const results: HostResult[] = [];
  const queue = [...machines];
  const workers = Array.from({ length: Math.max(1, Math.min(config.jobs, machines.length)) }, async () => {
    for (;;) {
      const machine = queue.shift();
      if (!machine) {
        return;
      }
      const result = await processHost(machine, config, options);
      console.log(`  ${result.name.padEnd(24)} ${result.outcome}`);
      results.push(result);
    }
  });
  await Promise.all(workers);

  const succeeded = results.filter((result) => /^(installed|upgraded|up-to-date|uninstalled)/.test(result.outcome)).length;
  const skipped = results.filter((result) => result.outcome.startsWith("skipped")).length;
  console.log(`\ndone: ${succeeded} ok, ${skipped} skipped, ${results.length - succeeded - skipped} failed`);
}

void main();
