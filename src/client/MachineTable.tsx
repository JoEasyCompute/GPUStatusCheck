import { useMemo, useState } from "react";
import type { MachineWithLatest } from "../shared/types";
import { formatStatus, formatTime } from "./formatters";
import { GpuJobPills } from "./GpuJobPills";
import { GroupCharts } from "./GroupCharts";
import { GroupStats } from "./GroupStats";
import { buildMachineGroups, computeGroupStats, type MachineGroupBy } from "./machineGroups";
import { sortMachines, type MachineSort, type MachineSortKey } from "./machineSort";

export function MachineTable({
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
  const [sort, setSort] = useState<MachineSort>({ key: "name", direction: "asc" });
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
  const groups = useMemo(
    () => buildMachineGroups(machines, groupBy).map((group) => ({
      ...group,
      machines: sortMachines(group.machines, sort),
    })),
    [machines, groupBy, sort],
  );
  const toggleSort = (key: MachineSortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  return (
    <div className="panel table-panel">
      <table>
        <thead>
          <tr>
            <SortableHeader label="Machine" sortKey="name" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Location" sortKey="location" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Owner" sortKey="owner" sort={sort} onSort={toggleSort} />
            <SortableHeader label="GPU type" sortKey="gpuType" sort={sort} onSort={toggleSort} />
            <SortableHeader label="GPUs" sortKey="gpus" sort={sort} onSort={toggleSort} align="num" />
            <SortableHeader label="Jobs" sortKey="jobs" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Notes" sortKey="notes" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Power (W)" sortKey="power" sort={sort} onSort={toggleSort} align="num" />
            <SortableHeader label="Temp (°C)" sortKey="temp" sort={sort} onSort={toggleSort} align="num" />
            <SortableHeader label="Checked" sortKey="checked" sort={sort} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {groups.flatMap((group) => [
            ...(group.label !== undefined
              ? [(
                <tr
                  key={`group-${group.label}`}
                  className="group-row"
                  aria-expanded={!collapsed.has(`${groupBy}:${group.label}`)}
                  onClick={() => toggleGroup(group.label!)}
                >
                  <td colSpan={11}>
                    <span className="caret" aria-hidden="true">{collapsed.has(`${groupBy}:${group.label}`) ? "▸" : "▾"}</span>
                    {group.label || "Unassigned"}
                    <GroupStats stats={computeGroupStats(group.machines)} />
                    <button
                      type="button"
                      className={`group-charts-toggle ${chartsOpen.has(`${groupBy}:${group.label}`) ? "active" : ""}`}
                      title="Toggle group history charts"
                      aria-expanded={chartsOpen.has(`${groupBy}:${group.label}`)}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleCharts(group.label!);
                      }}
                    >
                      Charts
                    </button>
                  </td>
                </tr>
              )]
              : []),
            ...(group.label !== undefined && chartsOpen.has(`${groupBy}:${group.label}`) && (groupBy === "owner" || groupBy === "location")
              ? [(
                <tr key={`group-charts-${group.label}`} className="group-charts-row">
                  <td colSpan={11}>
                    <GroupCharts groupBy={groupBy} label={group.label} />
                  </td>
                </tr>
              )]
              : []),
            ...(group.label !== undefined && collapsed.has(`${groupBy}:${group.label}`) ? [] : group.machines).map((machine) => (
            <tr key={machine.id} className={machine.id === selectedMachineId ? "selected" : ""} onClick={() => onSelect(machine.id!)}>
              <td className="name-cell">{machine.name}</td>
              <td>
                <span className={`status ${machine.latest?.status ?? "unknown"}`}>{formatStatus(machine.latest?.status)}</span>
                {machine.maintenance ? <span className="chip maintenance" title="Alerts muted while in maintenance">M</span> : null}
              </td>
              <td>{machine.location || "-"}</td>
              <td>{machine.owner || "-"}</td>
              <td>{machine.latest?.gpuType || "-"}</td>
              <td className="num">{machine.latest?.gpuCount ?? "-"}</td>
              <td><GpuJobPills latest={machine.latest} /></td>
              <td className="note-cell">{formatNotes(machine)}</td>
              <td className="num">{machine.latest?.gpuPowerW || "-"}</td>
              <td className="num">{machine.latest?.gpuAvgTempC || "-"}</td>
              <td className="time-cell">{formatTime(machine.latest?.checkedAt)}</td>
            </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: string;
  sortKey: MachineSortKey;
  sort: MachineSort;
  onSort: (key: MachineSortKey) => void;
  align?: "num";
}) {
  const active = sort.key === sortKey;
  return (
    <th className={align ?? ""}>
      <button className={`sort-header ${active ? "active" : ""}`} onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        <span aria-hidden="true">{active ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

function formatNotes(machine: MachineWithLatest): string {
  const notes = machine.activeGpuNotes ?? [];
  return notes.length === 0 ? "-" : notes.map((note) => note.note).join("; ");
}
