import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentOperationDialog } from "../src/client/AgentOperationDialog";
import { AgentOperationDrawer } from "../src/client/AgentOperationDrawer";
import {
  agentPresence,
  eligibleRetryMachineIds,
  selectVisibleMachines,
  toggleMachineSelection,
} from "../src/client/agentAdmin";
import type { AgentOperationDetail, MachineWithLatest, ProbeResult } from "../src/shared/types";

describe("agent administration UI helpers", () => {
  it("toggles only the requested machine and normalizes duplicate visible selection", () => {
    expect(toggleMachineSelection([1, 2], 2)).toEqual([1]);
    expect(toggleMachineSelection([1, 2], 3)).toEqual([1, 2, 3]);
    expect(selectVisibleMachines([1], [machine(2), machine(2), machine(3)])).toEqual([1, 2, 3]);
    expect(selectVisibleMachines([], [])).toEqual([]);
  });

  it("does not mutate selection when the visible machine list changes", () => {
    const selected = [1, 3];
    const visibleAfterFilter = [machine(2)];

    expect(selected).toEqual([1, 3]);
    expect(visibleAfterFilter.map((entry) => entry.id)).toEqual([2]);
  });

  it("retries failed, skipped, and interrupted machines only", () => {
    expect(eligibleRetryMachineIds(operationFixture())).toEqual([2, 3, 4]);
  });

  it("distinguishes installed, absent, and unknown agent presence", () => {
    expect(agentPresence(machine(1, { sshOk: true, agentVersion: "0.1.0" }))).toBe("installed");
    expect(agentPresence(machine(2, { sshOk: true, agentVersion: "" }))).toBe("absent");
    expect(agentPresence(machine(3, { sshOk: false }))).toBe("unknown");
    expect(agentPresence(machine(4))).toBe("unknown");
  });

  it("renders exact install and uninstall confirmations without credential material", () => {
    const machines = [machine(1), machine(2)];
    const install = renderToStaticMarkup(
      <AgentOperationDialog machines={machines} action="install" concurrency={4} submitting={false} onActionChange={() => {}} onConfirm={() => {}} onClose={() => {}} />,
    );
    const uninstall = renderToStaticMarkup(
      <AgentOperationDialog machines={machines} action="uninstall" concurrency={4} submitting={false} onActionChange={() => {}} onConfirm={() => {}} onClose={() => {}} />,
    );

    expect(install).toContain("Install / Upgrade");
    expect(install).toContain("alpha");
    expect(install).toContain("beta");
    expect(install).toContain("passwordless sudo");
    expect(uninstall).toContain("Uninstall agents");
    expect(uninstall).toContain("removes buffered agent data");
    expect(`${install}${uninstall}`).not.toContain("raw-admin-key");
  });

  it("renders mixed progress and the eligible retry count", () => {
    const markup = renderToStaticMarkup(
      <AgentOperationDrawer operation={operationFixture()} loadingError="" onClose={() => {}} onRetry={() => {}} />,
    );

    expect(markup).toContain("Agent operation #9");
    expect(markup).toContain("succeeded");
    expect(markup).toContain("failed");
    expect(markup).toContain("Retry 3 machines");
  });
});

function machine(id: number, latest?: Partial<ProbeResult>): MachineWithLatest {
  const name = id === 1 ? "alpha" : id === 2 ? "beta" : `machine-${id}`;
  const ip = `10.0.0.${id}`;
  return {
    id,
    name,
    ip,
    active: true,
    latest: latest ? { name, ip, sshOk: true, status: "ok", ...latest } : undefined,
  };
}

function operationFixture(): AgentOperationDetail {
  const statuses = ["succeeded", "failed", "skipped", "interrupted", "running"] as const;
  return {
    id: 9,
    action: "install",
    status: "failed",
    machineCount: 5,
    succeededCount: 1,
    skippedCount: 1,
    failedCount: 1,
    interruptedCount: 1,
    queuedAt: "2026-09-21T09:00:00.000Z",
    finishedAt: "2026-09-21T09:02:00.000Z",
    items: statuses.map((status, index) => ({
      id: index + 1,
      operationId: 9,
      machineId: index + 1,
      machineName: `machine-${index + 1}`,
      status,
      summary: status,
      output: status === "failed" ? "connection refused" : "",
    })),
  };
}
