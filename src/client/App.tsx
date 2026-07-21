import { useEffect, useMemo, useState } from "react";
import { buildSshCommand } from "../shared/ssh";
import type { EditableRuntimeConfig, GpuProcess, MachineWithLatest, PollStatus, ProbeResult, RuntimeConfig, Summary } from "../shared/types";
import { copyText } from "./clipboard";
import { FleetCharts } from "./FleetCharts";
import { MachineCards } from "./MachineCards";
import type { MachineGroupBy } from "./machineGroups";
import { MachineDetailModal } from "./MachineDetailModal";
import { MachineTable } from "./MachineTable";
import { formatElapsed, formatTime } from "./formatters";

type StatusFilter = "all" | "not_ok" | "ok" | "degraded" | "ssh_failed";
type ViewMode = "table" | "cards";

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
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [machines, setMachines] = useState<MachineWithLatest[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<number | undefined>();
  const [history, setHistory] = useState<ProbeResult[]>([]);
  const [processes, setProcesses] = useState<GpuProcess[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [gpuTypeFilter, setGpuTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => storedChoice("gpucheck.viewMode", ["table", "cards"], "table"));
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

  async function refresh() {
    try {
      const [summaryResponse, machinesResponse, configResponse, pollStatusResponse] = await Promise.all([
        fetch("/api/summary"),
        fetch("/api/machines"),
        fetch("/api/config"),
        fetch("/api/poll-status"),
      ]);
      setSummary(await summaryResponse.json());
      const nextMachines = await machinesResponse.json() as MachineWithLatest[];
      setMachines(nextMachines);
      setConfig(await configResponse.json());
      setPollStatus(await pollStatusResponse.json());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function triggerPoll() {
    setPolling(true);
    setPollMessage("");
    try {
      const response = await fetch("/api/poll-runs", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || response.statusText);
      }
      if (body.skipped) {
        setPollMessage("Poll already running");
      } else {
        setPollMessage(`Poll #${body.runId} complete`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPolling(false);
    }
  }

  async function saveSettings() {
    const pollIntervalSeconds = Number(settings.pollIntervalSeconds);
    const payload: EditableRuntimeConfig = {
      machinesPath: settings.machinesPath.trim(),
      pollIntervalSeconds,
    };

    setSavingSettings(true);
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(body.error || response.statusText);
      }
      const nextConfig = await response.json() as RuntimeConfig;
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSettings(false);
    }
  }

  async function toggleMaintenance(machine: MachineWithLatest) {
    try {
      const response = await fetch(`/api/machines/${machine.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maintenance: !machine.maintenance }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(body.error || response.statusText);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      fetch(`/api/machines/${selectedMachineId}/history?hours=24&limit=1000`).then((response) => response.json()),
      fetch(`/api/machines/${selectedMachineId}/processes?limit=200`).then((response) => response.json()),
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

  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId);

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
        <button className="primary" onClick={triggerPoll} disabled={polling}>{polling ? "Polling..." : "Poll now"}</button>
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
                onChange={(event) => {
                  setSettings((current) => ({ ...current, pollIntervalSeconds: event.target.value }));
                  setSettingsDirty(true);
                  setSettingsMessage("");
                }}
              />
            </label>
            <div className="settings-actions">
              <button onClick={saveSettings} disabled={savingSettings || !settingsDirty}>
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
        </div>
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
        <span className="toolbar-count">{filteredMachines.length} of {machines.length} machines</span>
      </section>

      <section className="layout">
        {viewMode === "table" ? (
          <MachineTable machines={filteredMachines} selectedMachineId={selectedMachineId} onSelect={setSelectedMachineId} groupBy={groupBy} />
        ) : (
          <MachineCards machines={filteredMachines} selectedMachineId={selectedMachineId} onSelect={setSelectedMachineId} groupBy={groupBy} />
        )}
      </section>

      {selectedMachine ? (
        <MachineDetailModal
          machine={selectedMachine}
          history={history}
          processes={processes}
          onToggleMaintenance={toggleMaintenance}
          onCopySsh={copySshCommand}
          onClose={() => {
            setSelectedMachineId(undefined);
            setHistory([]);
            setProcesses([]);
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
