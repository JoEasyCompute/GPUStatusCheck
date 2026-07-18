import { useMemo, useState } from "react";
import type { MachineWithLatest } from "../shared/types";
import { formatStatus, formatTime } from "./formatters";
import { GpuJobPills } from "./GpuJobPills";
import { formatPlatformOwner, sortMachines, type MachineSort, type MachineSortKey } from "./machineSort";

export function MachineTable({
  machines,
  selectedMachineId,
  onSelect,
  onCopySsh,
}: {
  machines: MachineWithLatest[];
  selectedMachineId?: number;
  onSelect: (id: number) => void;
  onCopySsh: (machine: MachineWithLatest) => void;
}) {
  const [sort, setSort] = useState<MachineSort>({ key: "name", direction: "asc" });
  const sortedMachines = useMemo(() => sortMachines(machines, sort), [machines, sort]);
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
            <SortableHeader label="IP" sortKey="ip" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Platform:Owner" sortKey="platformOwner" sort={sort} onSort={toggleSort} />
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
          {sortedMachines.map((machine) => (
            <tr key={machine.id} className={machine.id === selectedMachineId ? "selected" : ""} onClick={() => onSelect(machine.id!)}>
              <td className="name-cell">{machine.name}</td>
              <td>
                <span className={`status ${machine.latest?.status ?? "unknown"}`}>{formatStatus(machine.latest?.status)}</span>
                {machine.maintenance ? <span className="chip maintenance" title="Alerts muted while in maintenance">M</span> : null}
              </td>
              <td>
                <button
                  className="ip-copy"
                  title="Ctrl-click or Command-click to copy SSH command"
                  onClick={(event) => {
                    if (event.ctrlKey || event.metaKey) {
                      event.preventDefault();
                      event.stopPropagation();
                      onCopySsh(machine);
                    }
                  }}
                  onContextMenu={(event) => {
                    if (event.ctrlKey) {
                      event.preventDefault();
                      event.stopPropagation();
                      onCopySsh(machine);
                    }
                  }}
                >
                  {machine.ip}
                </button>
              </td>
              <td>{formatPlatformOwner(machine) || "-"}</td>
              <td>{machine.latest?.gpuType || "-"}</td>
              <td className="num">{machine.latest?.gpuCount ?? "-"}</td>
              <td><GpuJobPills latest={machine.latest} /></td>
              <td className="note-cell">{formatNotes(machine)}</td>
              <td className="num">{machine.latest?.gpuPowerW || "-"}</td>
              <td className="num">{machine.latest?.gpuAvgTempC || "-"}</td>
              <td className="time-cell">{formatTime(machine.latest?.checkedAt)}</td>
            </tr>
          ))}
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
