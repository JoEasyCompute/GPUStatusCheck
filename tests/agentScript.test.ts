import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("on-host agent script", () => {
  it("bounds the first journal scan and uses the cursor on later samples", () => {
    const root = mkdtempSync(join(tmpdir(), "gpucheck-agent-script-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const probe = join(root, "probe.sh");
    const journalCalls = join(root, "journalctl-calls");
    writeFileSync(probe, "#!/bin/sh\nprintf 'GPU_COUNT=1\\n'\n");
    writeFileSync(join(bin, "journalctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$GPUCHECK_JOURNAL_CALLS"
for arg in "$@"; do
  case "$arg" in --cursor-file=*) printf cursor > "\${arg#--cursor-file=}" ;; esac
done
echo 'kernel: NVRM: Xid 31'
`);
    chmodSync(join(bin, "journalctl"), 0o755);
    const script = resolve("scripts/agent/gpucheck-agent.sh");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GPUCHECK_AGENT_DIR: join(root, "state"),
      GPUCHECK_AGENT_PROBE: probe,
      GPUCHECK_JOURNAL_CALLS: journalCalls,
    };

    const first = spawnSync("sh", [script], { encoding: "utf8", env });
    expect(first.status).toBe(0);
    const callsAfterFirstSample = readFileSync(journalCalls, "utf8").trim().split("\n");
    expect(callsAfterFirstSample[0]).toContain("-n 500");

    const second = spawnSync("sh", [script], { encoding: "utf8", env });
    expect(second.status).toBe(0);
    const callsAfterSecondSample = readFileSync(journalCalls, "utf8").trim().split("\n");
    expect(callsAfterSecondSample).toHaveLength(2);
    expect(callsAfterSecondSample[1]).not.toContain("-n 500");
  });
});
