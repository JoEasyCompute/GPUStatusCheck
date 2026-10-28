import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("BMC IP probe", () => {
  it("reports the local IPMI LAN address when ipmitool can read it", () => {
    const output = runProbeWithIpmitool("printf '%s\\n' 'IP Address              : 192.168.20.42' 'IP Address Source       : Static Address'");
    expect(output.status).toBe(0);
    expect(output.stdout).toContain("BMC_IP_ADDRESS=192.168.20.42");
  });

  it("continues with an empty BMC address when the IPMI query fails", () => {
    const output = runProbeWithIpmitool("exit 1");
    expect(output.status).toBe(0);
    expect(output.stdout).toContain("BMC_IP_ADDRESS=");
  });
});

function runProbeWithIpmitool(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "gpu-bmc-probe-"));
  const command = join(dir, "ipmitool");
  writeFileSync(command, `#!/bin/sh\n${body}\n`);
  chmodSync(command, 0o755);
  const timeout = join(dir, "timeout");
  writeFileSync(timeout, "#!/bin/sh\nshift\nexec \"$@\"\n");
  chmodSync(timeout, 0o755);
  return spawnSync("sh", [resolve("scripts/remote-probe.sh"), "alpha", "local", "0"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
}
