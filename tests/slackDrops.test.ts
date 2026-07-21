import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db";
import { PollScheduler } from "../src/server/scheduler";
import { postSlack, type SlackPost } from "../src/server/slack";
import type { ProbeResult } from "../src/shared/types";

const UUIDS = ["GPU-aaaa1111-1111", "GPU-bbbb2222-2222", "GPU-cccc3333-3333"];

function setup(options: { channelsJson?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gpu-slack-"));
  const csvPath = join(dir, "machines.csv");
  const channelsPath = join(dir, "slack-channels.json");
  writeFileSync(csvPath, "name,ip,owner\nalpha,10.0.0.1,iota\n");
  writeFileSync(channelsPath, options.channelsJson ?? '{"iota":{"channel":"C0123","mention":"@ops"}}');
  const db = createDatabase(join(dir, "db.sqlite"));
  db.migrate();

  const config: AppConfig = {
    machinesPath: csvPath, dbPath: join(dir, "db.sqlite"), envPath: join(dir, ".env"),
    user: "ezc", fallbackUser: "", keyPath: "~/.ssh/test",
    connectTimeoutSeconds: 10, probeTimeoutSeconds: 60, jobs: 1, pollIntervalSeconds: 300,
    skipLogs: true, processArgsMaxChars: 512, pollOnStartup: false, retentionDays: 30,
    telegramBotToken: "", telegramChatId: "",
    slackBotToken: "xoxb-test", slackChannelsPath: channelsPath, slackDryRun: false,
    notifyRecovery: false, heartbeatUrl: "", host: "127.0.0.1", port: 0,
  };

  const posts: SlackPost[] = [];
  let failNext = false;
  let counter = 0;
  const sendSlack = async (post: SlackPost) => {
    if (failNext) {
      throw new Error("slack post failed: 200 channel_not_found");
    }
    posts.push(post);
    counter += 1;
    return `171000000.${counter}`;
  };

  /** Probe stub whose visible GPU set the test controls per poll. */
  let visible = [...UUIDS];
  const probeMachine = async (machine: { name: string; ip: string }): Promise<ProbeResult> => ({
    name: machine.name, ip: machine.ip, owner: "iota", sshOk: true, status: "ok",
    gpuCount: visible.length, gpuType: "4090", gpuJobs: "x".repeat(visible.length),
    gpuMetrics: visible.map((uuid, index) => ({ gpuIndex: index, uuid, gpuUtil: 10, powerW: 100 })),
  });

  const scheduler = new PollScheduler(db, config, probeMachine, async () => {}, sendSlack);
  return {
    db, config, posts, scheduler,
    setVisible: (next: string[]) => { visible = next; },
    setFailNext: (value: boolean) => { failNext = value; },
  };
}

describe("gpu drop announcements", () => {
  it("announces one incident per machine and threads each recovery into it", async () => {
    const harness = setup();

    // First poll establishes the roster; nothing has dropped yet.
    await harness.scheduler.pollOnce();
    expect(harness.posts).toHaveLength(0);

    // Two cards vanish in the same poll: one grouped message.
    harness.setVisible([UUIDS[0]]);
    await harness.scheduler.pollOnce();
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0].channel).toBe("C0123");
    expect(harness.posts[0].threadTs).toBeUndefined();
    expect(harness.posts[0].text).toContain("2 GPUs dropped");
    expect(harness.posts[0].text).toContain("@ops");
    expect(harness.posts[0].text).toContain("Now 1/3 visible");

    // One card returns: a threaded reply, broadcast so it surfaces in-channel.
    harness.setVisible([UUIDS[0], UUIDS[1]]);
    await harness.scheduler.pollOnce();
    expect(harness.posts).toHaveLength(2);
    expect(harness.posts[1].threadTs).toBe("171000000.1");
    expect(harness.posts[1].broadcast).toBe(true);
    expect(harness.posts[1].text).toContain("back after");

    // The last card returns: recovery reply plus the all-clear, same thread.
    harness.setVisible([...UUIDS]);
    await harness.scheduler.pollOnce();
    expect(harness.posts).toHaveLength(4);
    expect(harness.posts[3].threadTs).toBe("171000000.1");
    expect(harness.posts[3].text).toContain("all GPUs recovered");

    // Everything is settled, so a further poll says nothing more.
    await harness.scheduler.pollOnce();
    expect(harness.posts).toHaveLength(4);
  });

  it("retries the announcement next poll when Slack rejects it", async () => {
    const harness = setup();
    await harness.scheduler.pollOnce();

    harness.setVisible([UUIDS[0], UUIDS[1]]);
    harness.setFailNext(true);
    await harness.scheduler.pollOnce();
    expect(harness.posts).toHaveLength(0);
    // The incident exists but is unannounced, so it is retried rather than lost.
    const pending = harness.db.listPendingDropIncidents();
    expect(pending).toHaveLength(1);
    expect(pending[0].announcedAt).toBeUndefined();

    harness.setFailNext(false);
    await harness.scheduler.pollOnce();
    expect(harness.posts).toHaveLength(1);
    expect(harness.db.listPendingDropIncidents()).toHaveLength(0);
  });

  it("records the incident but stays silent for owners with no channel", async () => {
    const harness = setup({ channelsJson: '{"someone-else":"C999"}' });
    await harness.scheduler.pollOnce();

    harness.setVisible([UUIDS[0], UUIDS[1]]);
    await harness.scheduler.pollOnce();

    expect(harness.posts).toHaveLength(0);
    const incidents = harness.db.raw.prepare("SELECT COUNT(*) AS n FROM gpu_drop_incidents").get() as { n: number };
    expect(incidents.n).toBe(1);
  });

  it("treats a Slack ok:false body as a failure even though the HTTP status is 200", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ ok: false, error: "channel_not_found" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

    await expect(postSlack("xoxb-test", { channel: "C1", text: "hi" }))
      .rejects.toThrow(/channel_not_found/);

    globalThis.fetch = originalFetch;
  });

  it("returns the message ts on success so replies can thread", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ ok: true, ts: "1720000000.123456" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

    await expect(postSlack("xoxb-test", { channel: "C1", text: "hi" }))
      .resolves.toBe("1720000000.123456");

    globalThis.fetch = originalFetch;
  });
});
