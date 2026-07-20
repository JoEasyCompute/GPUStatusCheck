import { useMemo, useState } from "react";
import type { MachineWithLatest } from "../shared/types";
import { formatStatus, formatTime } from "./formatters";
import { GpuJobPills } from "./GpuJobPills";
import { GroupCharts } from "./GroupCharts";
import { GroupStats } from "./GroupStats";
import { buildMachineGroups, computeGroupStats, type MachineGroupBy } from "./machineGroups";

export function MachineCards({
  machines,
  selectedMachineId,
  onSelect,
  groupBy,
}: {
  machines: MachineWithLatest[];
  selectedMachineId?: number;
  onSelect: (id: number) => void;
  groupBy: MachineGroupBy;
}) {
  const groups = useMemo(() => buildMachineGroups(machines, groupBy), [machines, groupBy]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [chartsOpen, setChartsOpen] = useState<Set<string>>(new Set());
  const toggleGroup = (label: string) => {
    const key = `${groupBy}:${label}`;
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  const toggleCharts = (label: string) => {
    const key = `${groupBy}:${label}`;
    setChartsOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (machines.length === 0) {
    return <p className="empty-chart">No machines match the current filter.</p>;
  }

  return (
    <div className="machine-cards-wrap">
      {groups.map((group) => {
        const isCollapsed = group.label !== undefined && collapsed.has(`${groupBy}:${group.label}`);
        return (
          <section key={group.label ?? "__all__"}>
            {group.label !== undefined ? (
              <div className="card-group-head">
                <button type="button" className="card-group-title" aria-expanded={!isCollapsed} onClick={() => toggleGroup(group.label!)}>
                  <span className="caret" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                  {group.label || "Unassigned"}
                  <GroupStats stats={computeGroupStats(group.machines)} />
                </button>
                <button
                  type="button"
                  className={`group-charts-toggle ${chartsOpen.has(`${groupBy}:${group.label}`) ? "active" : ""}`}
                  title="Toggle group history charts"
                  aria-expanded={chartsOpen.has(`${groupBy}:${group.label}`)}
                  onClick={() => toggleCharts(group.label!)}
                >
                  Charts
                </button>
              </div>
            ) : null}
            {group.label !== undefined && chartsOpen.has(`${groupBy}:${group.label}`) && (groupBy === "owner" || groupBy === "location") ? (
              <div className="group-charts-panel">
                <GroupCharts groupBy={groupBy} label={group.label} />
              </div>
            ) : null}
            {!isCollapsed ? (
              <div className="machine-cards">
                {group.machines.map((machine) => (
                  <MachineCard
                    key={machine.id}
                    machine={machine}
                    selected={machine.id === selectedMachineId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function MachineCard({
  machine,
  selected,
  onSelect,
}: {
  machine: MachineWithLatest;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const latest = machine.latest;
  const status = latest?.status ?? "unknown";
  return (
    <div
      className={`machine-card ${status} ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(machine.id!)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(machine.id!);
        }
      }}
    >
      <div className="card-head">
        <strong className="card-name" title={machine.name}>{machine.name}</strong>
        {machine.maintenance ? <span className="chip maintenance" title="Alerts muted while in maintenance">M</span> : null}
        <span className={`status ${status}`}>{formatStatus(status)}</span>
      </div>
      <div className="card-gpu">
        {latest?.gpuCount !== null && latest?.gpuCount !== undefined ? `${latest.gpuCount} × ${latest.gpuType || "GPU"}` : "-"}
      </div>
      <GpuJobPills latest={latest} />
      <dl className="card-meta">
        <div><dt>Owner</dt><dd>{machine.owner || "-"}</dd></div>
        <div><dt>Location</dt><dd>{machine.location || "-"}</dd></div>
        <div><dt>Power</dt><dd>{latest?.gpuPowerW ? `${latest.gpuPowerW} W` : "-"}</dd></div>
        <div><dt>Temp</dt><dd>{latest?.gpuAvgTempC ? `${latest.gpuAvgTempC} °C` : "-"}</dd></div>
        <div className="card-checked"><dt>Checked</dt><dd>{formatTime(latest?.checkedAt)}</dd></div>
      </dl>
    </div>
  );
}

