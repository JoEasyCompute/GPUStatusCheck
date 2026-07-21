import { describe, expect, it } from "vitest";
import { detectGpuDrops, formatDowntime, type RosterEntry } from "../src/server/gpuDrops";
import { buildDropMessage, buildRecoveryMessage, parseChannelMap, resolveChannel } from "../src/server/slack";

const roster: RosterEntry[] = [
  { uuid: "GPU-aaaa1111", gpuIndex: 0, gpuType: "4090" },
  { uuid: "GPU-bbbb2222", gpuIndex: 1, gpuType: "4090" },
  { uuid: "GPU-cccc3333", gpuIndex: 2, gpuType: "4090" },
];

describe("detectGpuDrops", () => {
  it("reports nothing when every rostered card is visible", () => {
    const detection = detectGpuDrops(roster, {
      sshOk: true,
      visibleUuids: ["GPU-aaaa1111", "GPU-bbbb2222", "GPU-cccc3333"],
    });

    expect(detection.dropped).toEqual([]);
    expect(detection.skipped).toBe(false);
    expect(detection.wholeMachine).toBe(false);
  });

  it("identifies exactly which card vanished", () => {
    const detection = detectGpuDrops(roster, { sshOk: true, visibleUuids: ["GPU-aaaa1111", "GPU-cccc3333"] });

    expect(detection.dropped).toEqual([{ uuid: "GPU-bbbb2222", gpuIndex: 1, gpuType: "4090" }]);
    expect(detection.wholeMachine).toBe(false);
  });

  it("flags a whole-machine loss when no rostered card is visible", () => {
    const detection = detectGpuDrops(roster, { sshOk: true, visibleUuids: [] });

    expect(detection.dropped).toHaveLength(3);
    expect(detection.wholeMachine).toBe(true);
  });

  it("skips unreachable hosts so one outage cannot fire N false GPU alerts", () => {
    const detection = detectGpuDrops(roster, { sshOk: false, visibleUuids: [] });

    expect(detection.skipped).toBe(true);
    expect(detection.dropped).toEqual([]);
  });

  it("skips machines with an empty roster, so a first poll never storms", () => {
    const detection = detectGpuDrops([], { sshOk: true, visibleUuids: [] });

    expect(detection.skipped).toBe(true);
  });

  it("treats a card seen on another machine as absent from this roster", () => {
    // listMachineRoster drops moved cards from the old machine, so the roster
    // handed in here simply no longer contains them.
    const movedAway = roster.filter((entry) => entry.uuid !== "GPU-cccc3333");
    const detection = detectGpuDrops(movedAway, { sshOk: true, visibleUuids: ["GPU-aaaa1111", "GPU-bbbb2222"] });

    expect(detection.dropped).toEqual([]);
  });

  it("ignores blank uuids from probes that predate uuid capture", () => {
    const detection = detectGpuDrops(roster, { sshOk: true, visibleUuids: ["", "GPU-aaaa1111", "GPU-bbbb2222"] });

    expect(detection.dropped.map((entry) => entry.uuid)).toEqual(["GPU-cccc3333"]);
    expect(detection.visible.has("")).toBe(false);
  });
});

describe("formatDowntime", () => {
  it("scales units from minutes to days", () => {
    const base = "2026-07-20T00:00:00.000Z";
    expect(formatDowntime(base, "2026-07-20T00:12:00.000Z")).toBe("12m");
    expect(formatDowntime(base, "2026-07-20T03:30:00.000Z")).toBe("3h 30m");
    expect(formatDowntime(base, "2026-07-22T06:00:00.000Z")).toBe("2d 6h");
    expect(formatDowntime(base, "nonsense")).toBe("unknown");
  });
});

describe("slack channel routing", () => {
  it("accepts both shorthand and object forms", () => {
    const map = parseChannelMap('{"iota":"C0123","Vast":{"channel":"C0456","mention":"@ops"}}');

    expect(map.iota).toEqual({ channel: "C0123", mention: undefined });
    expect(map.Vast).toEqual({ channel: "C0456", mention: "@ops" });
  });

  it("ignores malformed entries rather than throwing", () => {
    const map = parseChannelMap('{"a":"","b":{},"c":{"channel":"  "},"d":{"channel":"C1"}}');

    expect(Object.keys(map)).toEqual(["d"]);
  });

  it("returns nothing for unmapped owners so idle machines stay quiet", () => {
    const map = parseChannelMap('{"iota":"C0123"}');

    expect(resolveChannel("iota", map)?.channel).toBe("C0123");
    expect(resolveChannel("IOTA", map)?.channel).toBe("C0123");
    expect(resolveChannel("idle", map)).toBeUndefined();
    expect(resolveChannel("", map)).toBeUndefined();
  });
});

describe("slack message building", () => {
  it("summarises a partial drop with one line per card", () => {
    const text = buildDropMessage({
      machineName: "EZC-Hydra-24",
      owner: "iota",
      dropped: [
        { uuid: "GPU-aaaa1111-2222", gpuIndex: 2, gpuType: "4090" },
        { uuid: "GPU-bbbb2222-3333", gpuIndex: 5, gpuType: "4090" },
      ],
      visibleCount: 6,
      expectedCount: 8,
      wholeMachine: false,
      reason: "nvidia-smi rc=255",
    });

    expect(text).toContain("🔴 EZC-Hydra-24 (iota) — 2 GPUs dropped");
    expect(text).toContain("4090 · slot 2 · aaaa1111");
    expect(text).toContain("Now 6/8 visible · nvidia-smi rc=255");
  });

  it("words a total loss as all GPUs not visible and prepends any mention", () => {
    const text = buildDropMessage({
      machineName: "alpha",
      owner: "Vast",
      dropped: roster,
      visibleCount: 0,
      expectedCount: 3,
      wholeMachine: true,
      mention: "@ops",
    });

    expect(text.startsWith("@ops\n")).toBe(true);
    expect(text).toContain("all 3 GPUs not visible");
  });

  it("reports downtime on recovery", () => {
    const text = buildRecoveryMessage(
      { uuid: "GPU-bbbb2222-3333", gpuIndex: 5, gpuType: "4090" },
      "2026-07-20T00:00:00.000Z",
      "2026-07-20T00:12:00.000Z",
    );

    expect(text).toBe("🟢 slot 5 (bbbb2222) back after 12m");
  });
});
