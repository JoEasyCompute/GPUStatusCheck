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

  it("uses non-interactive sudo when the SSH user cannot read the IPMI device", () => {
    const output = runProbeWithIpmitool(
      "if [ \"$BMC_SUDO\" = yes ]; then printf '%s\\n' 'IP Address : 10.10.20.228'; else exit 1; fi",
      true,
    );
    expect(output.status).toBe(0);
    expect(output.stdout).toContain("BMC_IP_ADDRESS=10.10.20.228");
  });
  it.each([
    ["Active", "IPMI_POWER_W=425"],
    ["Not Available", "IPMI_POWER_W="],
  ])("handles DCMI chassis power with measurement status %s", (status, expected) => {
    const output = runProbeWithIpmitool([
      'if [ "$3" = dcmi ]; then',
      `  printf '%s\\n' 'Instantaneous power reading: 425 Watts' 'Power Measurement: ${status}'`,
      "else",
      "  printf '%s\\n' 'IP Address: 192.168.20.42'",
      "fi",
    ].join("\n"), false, true);
    expect(output.status).toBe(0);
    expect(output.stdout.split("\n")).toContain(expected);
  });

});

function runProbeWithIpmitool(body: string, withSudo = false, nodeReadings = false) {
  const dir = mkdtempSync(join(tmpdir(), "gpu-bmc-probe-"));
  const command = join(dir, "ipmitool");
  writeFileSync(command, `#!/bin/sh\n${body}\n`);
  chmodSync(command, 0o755);
  const timeout = join(dir, "timeout");
  writeFileSync(timeout, "#!/bin/sh\nshift\nexec \"$@\"\n");
  chmodSync(timeout, 0o755);
  if (withSudo) {
    const sudo = join(dir, "sudo");
    writeFileSync(sudo, "#!/bin/sh\n[ \"$1\" = -n ] && shift\nBMC_SUDO=yes; export BMC_SUDO\nexec \"$@\"\n");
    chmodSync(sudo, 0o755);
  }
  const curl = join(dir, "curl");
  writeFileSync(curl, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return spawnSync("sh", [resolve("scripts/remote-probe.sh"), "alpha", "local", "0", nodeReadings ? "1" : "0"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
}
