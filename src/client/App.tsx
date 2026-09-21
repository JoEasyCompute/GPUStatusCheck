import { useEffect, useMemo, useReducer, useState } from "react";
import { buildSshCommand } from "../shared/ssh";
import type { AdminStatus, AgentAction, AgentOperation, AgentOperationDetail, EditableRuntimeConfig, GpuIdentity, GpuProcess, MachineWithLatest, PollStatus, ProbeResult, RuntimeConfig, Summary } from "../shared/types";
import { AdminAccess } from "./AdminAccess";
import { AgentOperationDialog } from "./AgentOperationDialog";
import { AgentOperationDrawer } from "./AgentOperationDrawer";
import { selectVisibleMachines, toggleMachineSelection } from "./agentAdmin";
import { adminSessionReducer, clearAdminKey, initialAdminSessionState, loadAdminKey, saveAdminKey } from "./adminSession";
import { ApiError, fetchAdminJson, fetchJson, fetchJsonArray } from "./api";
import { copyText } from "./clipboard";
import { FleetCharts } from "./FleetCharts";
import { GpuDetailModal } from "./GpuDetailModal";
import { GpuInventory } from "./GpuInventory";
import { MachineCards } from "./MachineCards";
import type { MachineGroupBy } from "./machineGroups";
import { MachineDetailModal } from "./MachineDetailModal";
import { MachineTable } from "./MachineTable";
import { formatElapsed, formatTime } from "./formatters";

type StatusFilter = "all" | "not_ok" | "ok" | "degraded" | "ssh_failed";
type ViewMode = "table" | "cards" | "gpus";

function storedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function storeChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing or storage disabled; the choice just won't persist.
  }
}

const emptySummary: Summary = {
  total: 0,
  ok: 0,
  degraded: 0,
  sshFailed: 0,
  totalPowerW: 0,
  averageTempC: null,
};

type SettingsForm = {
  machinesPath: string;
  pollIntervalSeconds: string;
};

export function App() {
  const [admin, dispatchAdmin] = useReducer(adminSessionReducer, initialAdminSessionState, (initial) => {
    try {
      const key = loadAdminKey(window.sessionStorage);
      return key ? adminSessionReducer(initial, { type: "restore", key }) : initial;
    } catch {
      return initial;
    }
  });
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [machines, setMachines] = useState<MachineWithLatest[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<number | undefined>();
  const [history, setHistory] = useState<ProbeResult[]>([]);
  const [processes, setProcesses] = useState<GpuProcess[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [gpuTypeFilter, setGpuTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => storedChoice("gpucheck.viewMode", ["table", "cards", "gpus"], "table"));
  const [gpus, setGpus] = useState<GpuIdentity[]>([]);
  const [selectedGpuUuid, setSelectedGpuUuid] = useState<string | undefined>();
  const [groupBy, setGroupBy] = useState<MachineGroupBy>(() => storedChoice("gpucheck.groupBy", ["none", "owner", "location"], "none"));
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<RuntimeConfig | undefined>();
  const [pollStatus, setPollStatus] = useState<PollStatus | undefined>();
  const [pollMessage, setPollMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const [settings, setSettings] = useState<SettingsForm>({ machinesPath: "", pollIntervalSeconds: "" });
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [agentAction, setAgentAction] = useState<AgentAction>("install");
  const [submittingAgentOperation, setSubmittingAgentOperation] = useState(false);
  const [agentOperation, setAgentOperation] = useState<AgentOperationDetail | undefined>();
  const [agentOperationError, setAgentOperationError] = useState("");

  function clearStoredAdminKey() {
    try {
      clearAdminKey(window.sessionStorage);
    } catch {
      // Storage unavailable; reducer state still locks this tab.
    }
  }

  function handleAdminError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearStoredAdminKey();
      dispatchAdmin({ type: "unauthorized", message: "Admin key rejected or rotated" });
    }
    setError(err instanceof Error ? err.message : String(err));
  }

  async function unlockAdmin(key: string) {
    dispatchAdmin({ type: "verifying", key });
    try {
      await fetchAdminJson<{ authenticated: true }>(key, "/api/admin/verify", { method: "POST" });
      try {
        saveAdminKey(window.sessionStorage, key);
      } catch {
        // Private mode may reject storage; current in-memory session still works.
      }
      dispatchAdmin({ type: "verified" });
      setError("");
    } catch (err) {
      clearStoredAdminKey();
      dispatchAdmin({ type: "verificationFailed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function lockAdmin() {
    clearStoredAdminKey();
    dispatchAdmin({ type: "lock" });
    setAgentDialogOpen(false);
  }

  function toggleAgentSelection(machineId: number) {
    dispatchAdmin({ type: "selection", machineIds: toggleMachineSelection(admin.selectedMachineIds, machineId) });
  }

  function selectVisibleForAgents() {
    dispatchAdmin({ type: "selection", machineIds: selectVisibleMachines(admin.selectedMachineIds, filteredMachines) });
  }

  async function submitAgentOperation() {
    if (admin.mode !== "unlocked") return;
    const activeIds = new Set(machines.filter((machine) => machine.active !== false).map((machine) => machine.id));
    const machineIds = [...new Set(admin.selectedMachineIds)].filter((id) => activeIds.has(id));
    if (machineIds.length === 0) {
      setError("Select at least one active machine");
      return;
    }
    setSubmittingAgentOperation(true);
    try {
      const operation = await fetchAdminJson<AgentOperationDetail>(admin.key, "/api/agent-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: agentAction, machineIds }),
      });
      setAgentOperation(operation);
      dispatchAdmin({ type: "lastOperation", operation });
      dispatchAdmin({ type: "selection", machineIds: [] });
      setAgentDialogOpen(false);
      setAgentOperationError("");
    } catch (err) {
      handleAdminError(err);
    } finally {
      setSubmittingAgentOperation(false);
    }
  }

  async function openRecentAgentOperation() {
    if (admin.mode !== "unlocked") return;
    try {
      const recent = await fetchAdminJson<AgentOperation[]>(admin.key, "/api/agent-operations?limit=20");
      if (recent.length === 0) {
        setError("No agent operations recorded yet");
        return;
      }
      const detail = await fetchAdminJson<AgentOperationDetail>(admin.key, `/api/agent-operations/${recent[0]!.id}`);
      setAgentOperation(detail);
      dispatchAdmin({ type: "lastOperation", operation: detail });
      setAgentOperationError("");
    } catch (err) {
      handleAdminError(err);
    }
  }

  async function refresh() {
    try {
      const [nextSummary, nextMachines, nextConfig, nextPollStatus, nextGpus] = await Promise.all([
        fetchJson<Summary>("/api/summary"),
        fetchJsonArray<MachineWithLatest>("/api/machines"),
        fetchJson<RuntimeConfig>("/api/config"),
        fetchJson<PollStatus>("/api/poll-status"),
        fetchJsonArray<GpuIdentity>("/api/gpus"),
      ]);
      setSummary(nextSummary);
      setMachines(nextMachines);
      setConfig(nextConfig);
      setPollStatus(nextPollStatus);
      setGpus(nextGpus);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function triggerPoll() {
    if (admin.mode !== "unlocked") return;
    setPolling(true);
    setPollMessage("");
    try {
      const body = await fetchAdminJson<{ runId: number; skipped: boolean }>(admin.key, "/api/poll-runs", { method: "POST" });
      if (body.skipped) {
        setPollMessage("Poll already running");
      } else {
        setPollMessage(`Poll #${body.runId} complete`);
      }
      await refresh();
    } catch (err) {
      handleAdminError(err);
    } finally {
      setPolling(false);
    }
  }

  async function saveSettings() {
    if (admin.mode !== "unlocked") return;
    const pollIntervalSeconds = Number(settings.pollIntervalSeconds);
    const payload: EditableRuntimeConfig = {
      machinesPath: settings.machinesPath.trim(),
      pollIntervalSeconds,
    };

    setSavingSettings(true);
    try {
      const nextConfig = await fetchAdminJson<RuntimeConfig>(admin.key, "/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setConfig(nextConfig);
      setSettings({
        machinesPath: nextConfig.machinesPath,
        pollIntervalSeconds: String(nextConfig.pollIntervalSeconds),
      });
      setSettingsDirty(false);
      setSettingsMessage("Saved");
      setError("");
      await refresh();
    } catch (err) {
      setSettingsMessage("");
      handleAdminError(err);
    } finally {
      setSavingSettings(false);
    }
  }

  async function toggleMaintenance(machine: MachineWithLatest) {
    if (admin.mode !== "unlocked") return;
    try {
      await fetchAdminJson<MachineWithLatest>(admin.key, `/api/machines/${machine.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maintenance: !machine.maintenance }),
      });
      await refresh();
    } catch (err) {
      handleAdminError(err);
    }
  }

  async function copySshCommand(machine: MachineWithLatest) {
    const command = buildSshCommand(machine, machine.latest?.sshUser || config?.sshUser || "ezc");
    try {
      await copyText(command);
      setCopyMessage(`Copied ${command}`);
      setError("");
      window.setTimeout(() => setCopyMessage(""), 3000);
    } catch (err) {
      setCopyMessage("");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchJson<AdminStatus>("/api/admin/status").then(async (status) => {
      if (cancelled) return;
      dispatchAdmin({ type: "status", enabled: status.enabled });
      if (status.enabled && admin.key) {
        await unlockAdmin(admin.key);
      }
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!agentOperation || admin.mode !== "unlocked" || !["queued", "running"].includes(agentOperation.status)) return;
    let cancelled = false;
    const load = () => {
      fetchAdminJson<AgentOperationDetail>(admin.key, `/api/agent-operations/${agentOperation.id}`)
        .then((detail) => {
          if (cancelled) return;
          setAgentOperation(detail);
          dispatchAdmin({ type: "lastOperation", operation: detail });
          setAgentOperationError("");
        })
        .catch((err) => {
          if (cancelled) return;
          setAgentOperationError(err instanceof Error ? err.message : String(err));
          handleAdminError(err);
        });
    };
    const timer = window.setInterval(load, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agentOperation?.id, agentOperation?.status, admin.mode, admin.key]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!config || settingsDirty) {
      return;
    }
    setSettings({
      machinesPath: config.machinesPath,
      pollIntervalSeconds: String(config.pollIntervalSeconds),
    });
  }, [config, settingsDirty]);

  useEffect(() => {
    if (!selectedMachineId) {
      return;
    }
    let cancelled = false;
    setHistory([]);
    setProcesses([]);
    Promise.all([
      fetchJsonArray<ProbeResult>(`/api/machines/${selectedMachineId}/history?hours=24&limit=1000`),
      fetchJsonArray<GpuProcess>(`/api/machines/${selectedMachineId}/processes?limit=200`),
    ]).then(([nextHistory, nextProcesses]) => {
      if (cancelled) {
        return;
      }
      setHistory(nextHistory);
      setProcesses(nextProcesses);
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedMachineId]);

  useEffect(() => {
    if (!selectedMachineId) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedMachineId(undefined);
        setHistory([]);
        setProcesses([]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedMachineId]);

  const gpuTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const machine of machines) {
      const gpuType = machine.latest?.gpuType;
      if (gpuType) {
        counts.set(gpuType, (counts.get(gpuType) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [machines]);

  const filteredMachines = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return machines.filter((machine) => {
      const status = machine.latest?.status ?? "unknown";
      const statusMatches = statusFilter === "all"
        || (statusFilter === "not_ok" ? status !== "ok" : status === statusFilter);
      const gpuTypeMatches = gpuTypeFilter === "all" || (machine.latest?.gpuType ?? "") === gpuTypeFilter;
      const searchMatches = !needle || [machine.name, machine.ip, machine.platform, machine.owner, machine.location]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle));
      return statusMatches && gpuTypeMatches && searchMatches;
    });
  }, [machines, search, statusFilter, gpuTypeFilter]);

  const filteredGpus = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return gpus.filter((gpu) => {
      const typeMatches = gpuTypeFilter === "all" || gpu.gpuType === gpuTypeFilter;
      const searchMatches = !needle || [gpu.uuid, gpu.gpuType, gpu.lastMachineName, gpu.lastOwner]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle));
      return typeMatches && searchMatches;
    });
  }, [gpus, search, gpuTypeFilter]);

  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId);
  const selectedAgentMachines = machines.filter((machine) => machine.id !== undefined && admin.selectedMachineIds.includes(machine.id));

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>GPU Status</h1>
          <p className="runtime-meta">
            <span>Inventory <strong>{config?.machinesPath ?? "-"}</strong></span>
            <span>Database <strong>{config?.dbPath ?? "-"}</strong></span>
          </p>
        </div>
        <div className="topbar-actions">
          <AdminAccess state={admin} protocol={window.location.protocol} onUnlock={unlockAdmin} onLock={lockAdmin} />
          <button className="primary" onClick={triggerPoll} disabled={polling || admin.mode !== "unlocked"}>{polling ? "Polling..." : "Poll now"}</button>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}
      {copyMessage ? <div className="notice">{copyMessage}</div> : null}

      <section className="summary-grid">
        <SummaryCard label="Machines" value={summary.total} />
        <SummaryCard label="OK" value={summary.ok} tone="ok" />
        <SummaryCard label="Degraded" value={summary.degraded} tone="degraded" />
        <SummaryCard label="SSH failed" value={summary.sshFailed} tone="failed" />
        <SummaryCard label="Total power" value={formatWatts(summary.totalPowerW)} unit={summary.totalPowerW >= 10000 ? "kW" : "W"} />
        <SummaryCard label="Avg temp" value={summary.averageTempC === null ? "-" : summary.averageTempC.toFixed(1)} unit="°C" />
      </section>

      <section className="control-row">
        <div className="panel poll-panel">
          <div className="panel-head">
            <h2>Poll status</h2>
            <span className={`poll-state ${pollStatus?.running ? "running" : ""}`}>
              <span className="dot" />
              {pollStatus?.running ? "Running" : "Idle"}
            </span>
            <p className="runtime-meta">
              <span>Interval <strong>{pollStatus?.pollIntervalSeconds ?? "-"}s</strong></span>
              <span>CSV <strong>{pollStatus?.machinesPath ?? "-"}</strong></span>
            </p>
          </div>
          <dl className="poll-metrics">
            <div><dt>Run</dt><dd>{pollStatus?.currentRunId ? `#${pollStatus.currentRunId}` : "-"}</dd></div>
            <div><dt>Machines</dt><dd>{pollStatus?.machineCount ?? "-"}</dd></div>
            <div><dt>Elapsed</dt><dd>{formatElapsed(pollStatus, now)}</dd></div>
            <div><dt>Started</dt><dd>{formatTime(pollStatus?.startedAt)}</dd></div>
            <div><dt>Finished</dt><dd>{formatTime(pollStatus?.lastFinishedAt)}</dd></div>
            <div><dt>Skipped</dt><dd>{formatTime(pollStatus?.lastSkippedAt)}</dd></div>
          </dl>
          {pollStatus?.lastError || pollMessage ? (
            <div className="poll-notes">
              {pollStatus?.lastError ? <span className="failed-text">{pollStatus.lastError}</span> : null}
              {pollMessage ? <span>{pollMessage}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="panel settings-panel">
          <div className="panel-head">
            <h2>Config</h2>
            <p className="runtime-meta">
              <span>Env <strong>{config?.envPath ?? "-"}</strong></span>
            </p>
          </div>
          <div className="settings-fields">
            <label>
              <span>CSV file</span>
              <input
                value={settings.machinesPath}
                disabled={admin.mode !== "unlocked"}
                onChange={(event) => {
                  setSettings((current) => ({ ...current, machinesPath: event.target.value }));
                  setSettingsDirty(true);
                  setSettingsMessage("");
                }}
              />
            </label>
            <label>
              <span>Poll seconds</span>
              <input
                type="number"
                min="1"
                step="1"
                value={settings.pollIntervalSeconds}
                disabled={admin.mode !== "unlocked"}
                onChange={(event) => {
                  setSettings((current) => ({ ...current, pollIntervalSeconds: event.target.value }));
                  setSettingsDirty(true);
                  setSettingsMessage("");
                }}
              />
            </label>
            <div className="settings-actions">
              <button onClick={saveSettings} disabled={savingSettings || !settingsDirty || admin.mode !== "unlocked"}>
                {savingSettings ? "Saving..." : "Save"}
              </button>
              {settingsMessage ? <span>{settingsMessage}</span> : null}
            </div>
          </div>
        </div>
      </section>

      <FleetCharts />

      <section className="toolbar">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, IP, platform, owner, location" />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
          <option value="all">All statuses</option>
          <option value="not_ok">Not OK</option>
          <option value="ok">OK</option>
          <option value="degraded">Degraded</option>
          <option value="ssh_failed">SSH failed</option>
        </select>
        <select value={gpuTypeFilter} onChange={(event) => setGpuTypeFilter(event.target.value)} aria-label="Filter by GPU type">
          <option value="all">All GPU types</option>
          {gpuTypeCounts.map(([gpuType, count]) => (
            <option key={gpuType} value={gpuType}>{gpuType} ({count})</option>
          ))}
        </select>
        <div className="chart-tabs view-toggle" role="tablist" aria-label="Display mode">
          <button
            role="tab"
            aria-selected={viewMode === "table"}
            className={`chart-tab ${viewMode === "table" ? "active" : ""}`}
            onClick={() => {
              setViewMode("table");
              storeChoice("gpucheck.viewMode", "table");
            }}
          >
            Table
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "cards"}
            className={`chart-tab ${viewMode === "cards" ? "active" : ""}`}
            onClick={() => {
              setViewMode("cards");
              storeChoice("gpucheck.viewMode", "cards");
            }}
          >
            Cards
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "gpus"}
            className={`chart-tab ${viewMode === "gpus" ? "active" : ""}`}
            onClick={() => {
              setViewMode("gpus");
              storeChoice("gpucheck.viewMode", "gpus");
            }}
          >
            GPUs
          </button>
        </div>
        {viewMode !== "gpus" ? (
          <select
            value={groupBy}
            onChange={(event) => {
              const next = event.target.value as MachineGroupBy;
              setGroupBy(next);
              storeChoice("gpucheck.groupBy", next);
            }}
          >
            <option value="none">No grouping</option>
            <option value="owner">Group by owner</option>
            <option value="location">Group by location</option>
          </select>
        ) : null}
        {admin.mode === "unlocked" ? (
          <div className="agent-admin-actions">
            {viewMode !== "gpus" ? <button onClick={selectVisibleForAgents}>Select visible</button> : null}
            <button onClick={() => dispatchAdmin({ type: "selection", machineIds: [] })} disabled={admin.selectedMachineIds.length === 0}>Clear selection</button>
            <button className="primary" onClick={() => setAgentDialogOpen(true)} disabled={admin.selectedMachineIds.length === 0}>
              Manage agents ({admin.selectedMachineIds.length})
            </button>
            <button onClick={() => void openRecentAgentOperation()}>Recent operations</button>
          </div>
        ) : null}
        <span className="toolbar-count">
          {viewMode === "gpus"
            ? `${filteredGpus.length} of ${gpus.length} GPUs`
            : `${filteredMachines.length} of ${machines.length} machines`}
        </span>
      </section>

      <section className="layout">
        {viewMode === "table" ? (
          <MachineTable
            machines={filteredMachines}
            selectedMachineId={selectedMachineId}
            onSelect={setSelectedMachineId}
            groupBy={groupBy}
            adminUnlocked={admin.mode === "unlocked"}
            selectedMachineIds={admin.selectedMachineIds}
            onToggleMachineSelection={toggleAgentSelection}
          />
        ) : null}
        {viewMode === "cards" ? (
          <MachineCards
            machines={filteredMachines}
            selectedMachineId={selectedMachineId}
            onSelect={setSelectedMachineId}
            groupBy={groupBy}
            adminUnlocked={admin.mode === "unlocked"}
            selectedMachineIds={admin.selectedMachineIds}
            onToggleMachineSelection={toggleAgentSelection}
          />
        ) : null}
        {viewMode === "gpus" ? (
          <GpuInventory gpus={filteredGpus} selectedUuid={selectedGpuUuid} onSelect={setSelectedGpuUuid} />
        ) : null}
      </section>

      {selectedMachine ? (
        <MachineDetailModal
          machine={selectedMachine}
          history={history}
          processes={processes}
          onToggleMaintenance={toggleMaintenance}
          adminUnlocked={admin.mode === "unlocked"}
          onCopySsh={copySshCommand}
          onSelectGpu={(uuid) => {
            setSelectedMachineId(undefined);
            setHistory([]);
            setProcesses([]);
            setSelectedGpuUuid(uuid);
          }}
          onClose={() => {
            setSelectedMachineId(undefined);
            setHistory([]);
            setProcesses([]);
          }}
        />
      ) : null}

      {selectedGpuUuid ? (
        <GpuDetailModal
          uuid={selectedGpuUuid}
          onClose={() => setSelectedGpuUuid(undefined)}
          onOpenMachine={(machineId) => {
            setSelectedGpuUuid(undefined);
            setSelectedMachineId(machineId);
          }}
        />
      ) : null}

      {agentDialogOpen ? (
        <AgentOperationDialog
          machines={selectedAgentMachines}
          action={agentAction}
          concurrency={config?.agentInstallJobs ?? 4}
          submitting={submittingAgentOperation}
          onActionChange={setAgentAction}
          onConfirm={() => void submitAgentOperation()}
          onClose={() => setAgentDialogOpen(false)}
        />
      ) : null}

      {agentOperation ? (
        <AgentOperationDrawer
          operation={agentOperation}
          loadingError={agentOperationError}
          onClose={() => setAgentOperation(undefined)}
          onRetry={(machineIds) => {
            dispatchAdmin({ type: "selection", machineIds });
            setAgentAction(agentOperation.action);
            setAgentDialogOpen(true);
          }}
        />
      ) : null}
    </main>
  );
}

function SummaryCard({ label, value, unit, tone }: { label: string; value: string | number; unit?: string; tone?: "ok" | "degraded" | "failed" }) {
  return (
    <div className={`summary-card ${tone ?? ""}`}>
      <span>
        {tone ? <span className="dot" /> : null}
        {label}
      </span>
      <strong>
        {value}
        {unit ? <small>{unit}</small> : null}
      </strong>
    </div>
  );
}

function formatWatts(watts: number): string {
  if (watts >= 10000) {
    return (watts / 1000).toFixed(1);
  }
  return watts.toFixed(0);
}
