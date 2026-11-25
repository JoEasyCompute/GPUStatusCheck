import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db";
import { buildRemoteScript, parseProbeOutput } from "../src/server/probe";

describe("GPU PCIe links", () => {
  const metrics = [
    "GPU_METRICS<<__GPUCHECK_EOF__",
    "0, 00000000:65:00.0, 91, 42, 67, 312.5, 450.0, 2520, 10501, GPU-aaaa1111-2222-3333-4444-555566667777",
    "1, 00000000:B3:00.0, 0, 0, 51, 48.2, 450.0, 210, 405, GPU-bbbb1111-2222-3333-4444-555566667777",
    "__GPUCHECK_EOF__",
  ];

  it("associates optional link readings with the original GPU metrics by index", () => {
    const parsed = parseProbeOutput([
      ...metrics,
      "GPU_PCIE_LINKS<<__GPUCHECK_EOF__",
      "1|Unknown|16.0 GT/s PCIe|-1|16",
      "0|8.0 GT/s PCIe|32.0 GT/s PCIe|8|16",
      "|99 GT/s|99 GT/s|99|99",
      "__GPUCHECK_EOF__",
    ].join("\n"), 200);

    expect(parsed.gpuMetrics[0]).toMatchObject({
      pcieLinkSpeedGtps: 8, pcieMaxLinkSpeedGtps: 32, pcieLinkWidth: 8, pcieMaxLinkWidth: 16,
    });
    expect(parsed.gpuMetrics[1]).toMatchObject({
      pcieLinkSpeedGtps: null, pcieMaxLinkSpeedGtps: 16, pcieLinkWidth: null, pcieMaxLinkWidth: 16,
    });
    expect(parseProbeOutput(metrics.join("\n"), 200).gpuMetrics[0]).not.toHaveProperty("pcieLinkWidth");
  });

  it("reads Linux sysfs using normalized NVIDIA PCI addresses without changing GPU telemetry", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpucheck-pcie-"));
    try {
      writeFileSync(join(dir, "nvidia-smi"), `#!/bin/sh
case "$1" in
  -L) echo 'GPU 0: NVIDIA (UUID: GPU-aaaa1111-2222-3333-4444-555566667777)' ;;
  --query-gpu=*) echo '${metrics[1].replace(":65:", ":A5:")}' ;;
esac
`, { mode: 0o755 });
      writeFileSync(join(dir, "cat"), `#!/bin/sh
case "$1" in
  /sys/bus/pci/devices/0000:a5:00.0/current_link_speed) echo '8.0 GT/s PCIe' ;;
  /sys/bus/pci/devices/0000:a5:00.0/max_link_speed) echo '32.0 GT/s PCIe' ;;
  /sys/bus/pci/devices/0000:a5:00.0/current_link_width) echo 8 ;;
  /sys/bus/pci/devices/0000:a5:00.0/max_link_width) echo 16 ;;
  *) exec /bin/cat "$@" ;;
esac
`, { mode: 0o755 });
      for (const command of ["curl", "ipmitool", "sudo"]) {
        writeFileSync(join(dir, command), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      }

      const result = spawnSync("sh", ["-s", "--", "fixture", "127.0.0.1", "0", "1"], {
        input: buildRemoteScript(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(0);
      expect(parseProbeOutput(result.stdout, 200).gpuMetrics[0]).toMatchObject({
        gpuIndex: 0, powerW: 312.5,
        pcieLinkSpeedGtps: 8, pcieMaxLinkSpeedGtps: 32, pcieLinkWidth: 8, pcieMaxLinkWidth: 16,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists link readings on both the current and historical metrics", () => {
    const db = createDatabase(":memory:");
    try {
      db.migrate();
      const machine = db.upsertMachine({ name: "alpha", ip: "10.0.0.1" });
      const pollRunId = db.createPollRun(1);
      const link = { pcieLinkSpeedGtps: 8, pcieMaxLinkSpeedGtps: 32, pcieLinkWidth: 8, pcieMaxLinkWidth: 16 };
      db.insertProbeResult(pollRunId, machine.id!, {
        name: "alpha", ip: "10.0.0.1", sshOk: true, status: "ok",
        gpuMetrics: [{ gpuIndex: 0, ...link }],
      });
      expect(db.getMachine(machine.id!)?.latest?.gpuMetrics?.[0]).toMatchObject(link);
      expect(db.listHistory(machine.id!)[0]?.gpuMetrics?.[0]).toMatchObject(link);
    } finally {
      db.close();
    }
  });
});
