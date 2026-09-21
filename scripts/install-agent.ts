/** Installs, upgrades, or uninstalls the optional on-host agent over SSH. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundledAgentVersion,
  parseInstallAgentArgs,
  runAgentAction,
  type AgentInstallTarget,
} from "../src/server/agentInstaller";
import { loadConfig } from "../src/server/config";
import { readInventoryFromFile } from "../src/server/inventory";

const usage = "Usage: npm run agent:install -- [--csv <path>] [--only <name-or-ip>] [--uninstall] [--force]";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options;
  try {
    options = parseInstallAgentArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 1;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }

  const config = loadConfig();
  const csvPath = options.csvPath ?? config.machinesPath;
  let machines = readInventoryFromFile(csvPath);
  if (options.only) {
    machines = machines.filter((machine) => machine.name === options.only || machine.ip.startsWith(options.only!));
    if (machines.length === 0) {
      console.error(`no machine matching "${options.only}" in ${csvPath}`);
      return 1;
    }
  }

  console.log(`${options.action === "uninstall" ? "Uninstalling" : "Installing"} agent v${bundledAgentVersion()} on ${machines.length} host(s) from ${csvPath}\n`);
  const results: Array<{ name: string; outcome: "succeeded" | "skipped" | "failed"; summary: string }> = [];
  const queue = [...machines];
  const workers = Array.from({ length: Math.max(1, Math.min(config.jobs, machines.length)) }, async () => {
    for (;;) {
      const machine = queue.shift();
      if (!machine) return;
      const target: AgentInstallTarget = {
        machineId: machine.id ?? 0,
        name: machine.name,
        sshHost: machine.sshHost ?? machine.ip,
        sshPort: machine.sshPort ?? 22,
      };
      const result = await runAgentAction(target, options.action, {
        user: config.user,
        keyPath: config.keyPath,
        connectTimeoutSeconds: config.connectTimeoutSeconds,
        force: options.force,
      });
      console.log(`  ${machine.name.padEnd(24)} ${result.summary}`);
      results.push({ name: machine.name, outcome: result.outcome, summary: result.summary });
    }
  });
  await Promise.all(workers);

  const succeeded = results.filter((result) => result.outcome === "succeeded").length;
  const skipped = results.filter((result) => result.outcome === "skipped").length;
  console.log(`\ndone: ${succeeded} ok, ${skipped} skipped, ${results.length - succeeded - skipped} failed`);
  return results.some((result) => result.outcome === "failed") ? 1 : 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
