import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { buildRemoteScript, isAuthFailure, parseGpuProcesses, parseProbeOutput } from "../src/server/probe";

describe("probe parsing", () => {
  it("parses probe scalars and blocks", () => {
    const parsed = parseProbeOutput(
      [
        "REMOTE_HOST=alpha",
        "UPTIME_PRETTY=up 1 hour",
        "NVIDIA_SMI_RC=0",
        "GPU_COUNT=8",
        "GPU_TYPE=NVIDIA GeForce RTX 4090",
        "GPU_JOBS=DDDDxxxx",
        "GPU_POWER_W=1234.6",
        "GPU_AVG_TEMP_C=67.5",
        "NET_RX_BPS=1250000",
        "NET_TX_BPS=340000",
        "CPU_MODEL=AMD EPYC 7543 32-Core Processor",
        "CPU_CORES=128",
        "CPU_UTIL_PCT=42.7",
        "MEM_TOTAL_KB=527884568",
        "MEM_USED_PCT=31.4",
        "DISK_TOTAL_KB=1843200000",
        "DISK_USED_PCT=67",
        "BUS_OFF=0",
        "GPU_METRICS<<__GPUCHECK_EOF__",
        "0, 00000000:65:00.0, 91, 42, 67, 312.5, 450.0, 2520, 10501, GPU-aaaa1111-2222-3333-4444-555566667777",
        "1, 00000000:B3:00.0, 0, 0, 51, 48.2, 450.0, 210, 405, GPU-bbbb1111-2222-3333-4444-555566667777",
        "__GPUCHECK_EOF__",
        "NVIDIA_SMI_OUTPUT<<__GPUCHECK_EOF__",
        "GPU 0: NVIDIA",
        "__GPUCHECK_EOF__",
        "PMON_OUTPUT<<__GPUCHECK_EOF__",
        "# gpu pid type sm mem enc dec command",
        "0 1234 C 88 42 0 0 python",
        "__GPUCHECK_EOF__",
        "PS_OUTPUT<<__GPUCHECK_EOF__",
        "1234 joseph 00:10:21 python python train.py --batch 32",
        "__GPUCHECK_EOF__",
      ].join("\n"),
      512,
    );

    expect(parsed.remoteHost).toBe("alpha");
    expect(parsed.gpuType).toBe("4090");
    expect(parsed.gpuJobs).toBe("DDDDxxxx");
    expect(parsed.gpuPowerW).toBe("1234.6");
    expect(parsed.gpuAvgTempC).toBe("67.5");
    expect(parsed.netRxBps).toBe(1250000);
    expect(parsed.netTxBps).toBe(340000);
    expect(parsed.cpuModel).toBe("AMD EPYC 7543 32-Core Processor");
    expect(parsed.cpuCores).toBe(128);
    expect(parsed.cpuUtilPct).toBe(42.7);
    expect(parsed.memTotalKb).toBe(527884568);
    expect(parsed.memUsedPct).toBe(31.4);
    expect(parsed.diskTotalKb).toBe(1843200000);
    expect(parsed.diskUsedPct).toBe(67);
    expect(parsed.gpuMetrics).toEqual([
      { gpuIndex: 0, pciBusId: "00000000:65:00.0", gpuUtil: 91, memUtil: 42, tempC: 67, powerW: 312.5, powerLimitW: 450, graphicsClockMhz: 2520, memoryClockMhz: 10501, uuid: "GPU-aaaa1111-2222-3333-4444-555566667777" },
      { gpuIndex: 1, pciBusId: "00000000:B3:00.0", gpuUtil: 0, memUtil: 0, tempC: 51, powerW: 48.2, powerLimitW: 450, graphicsClockMhz: 210, memoryClockMhz: 405, uuid: "GPU-bbbb1111-2222-3333-4444-555566667777" },
    ]);
    expect(parsed.processes[0]).toMatchObject({
      gpuIndex: 0,
      pid: 1234,
      command: "python",
      user: "joseph",
      processName: "python",
      commandLine: "python train.py --batch 32",
    });
  });

  it("enriches pmon processes with ps command lines and truncates long args", () => {
    const processes = parseGpuProcesses(
      "# gpu pid type sm mem enc dec command\n0 99 C 10 20 0 0 python\n",
      "99 user 01:02:03 python python very-long-script-name.py --abcdef\n",
      18,
    );

    expect(processes).toHaveLength(1);
    expect(processes[0]?.commandLine).toBe("python very-long-s");
  });

  it("marks every known GPU job slot as error when bus-off is suspected", () => {
    const parsed = parseProbeOutput(
      [
        "GPU_COUNT=4",
        "GPU_JOBS=Dxxx",
        "BUS_OFF=1",
      ].join("\n"),
      512,
    );

    expect(parsed.busOffSuspected).toBe(true);
    expect(parsed.gpuJobs).toBe("EEEE");
  });

  it("uses an error marker when bus-off is suspected but GPU count is unknown", () => {
    const parsed = parseProbeOutput(
      [
        "GPU_COUNT=0",
        "GPU_JOBS=",
        "BUS_OFF=1",
      ].join("\n"),
      512,
    );

    expect(parsed.busOffSuspected).toBe(true);
    expect(parsed.gpuJobs).toBe("E");
  });

  it("classifies auth failures as retryable with the fallback user", () => {
    expect(isAuthFailure("ezc@10.0.0.5: Permission denied (publickey).")).toBe(true);
    expect(isAuthFailure("Authentication failed.")).toBe(true);
    expect(isAuthFailure("ssh: connect to host 10.0.0.5 port 22: Network is unreachable")).toBe(false);
    expect(isAuthFailure("ssh: connect to host 10.0.0.5 port 22: Connection refused")).toBe(false);
    expect(isAuthFailure("probe timed out after 60s")).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });

  it("builds remote script with pmon and bounded ps enrichment", () => {
    const script = buildRemoteScript();

    expect(script).toContain("nvidia-smi pmon -c 1");
    expect(script).toContain("--query-gpu=index,pci.bus_id,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.current.graphics,clocks.current.memory,uuid");
    expect(script).toContain("ps -p");
    expect(script).toContain("GPU_METRICS<<__GPUCHECK_EOF__");
    expect(script).toContain("CPU_UTIL_PCT=");
    expect(script).toContain("MEM_USED_PCT=");
    expect(script).toContain("DISK_USED_PCT=");
    expect(script).toContain("PMON_OUTPUT<<__GPUCHECK_EOF__");
    expect(script).toContain("PS_OUTPUT<<__GPUCHECK_EOF__");
  });

  it("builds a POSIX shell script without escaped parameter expansions", () => {
    const script = buildRemoteScript();
    const syntaxCheck = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });

    expect(script).not.toContain("\\${");
    expect(syntaxCheck.status).toBe(0);
    expect(syntaxCheck.stderr).toBe("");
  });
});
