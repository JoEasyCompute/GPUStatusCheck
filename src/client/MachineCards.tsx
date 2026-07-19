import { useMemo } from "react";
import type { MachineWithLatest } from "../shared/types";
import { formatStatus, formatTime } from "./formatters";
import { GpuJobPills } from "./GpuJobPills";
import { buildMachineGroups, type MachineGroupBy } from "./machineGroups";

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

  if (machines.length === 0) {
    return <p className="empty-chart">No machines match the current filter.</p>;
  }

  return (
    <div className="machine-cards-wrap">
      {groups.map((group) => (
        <section key={group.label ?? "__all__"}>
          {group.label !== undefined ? (
            <h3 className="card-group-title">
              {group.label || "Unassigned"}
              <span>{group.machines.length}</span>
            </h3>
          ) : null}
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
        </section>
      ))}
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

