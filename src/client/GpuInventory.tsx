import { useMemo, useState } from "react";
import type { GpuIdentity } from "../shared/types";
import { formatTime } from "./formatters";
import { shortUuid } from "./gpuFormat";

type GpuSortKey = "uuid" | "gpuType" | "machine" | "slot" | "owner" | "sightings" | "lastSeen";
type GpuSort = { key: GpuSortKey; direction: "asc" | "desc" };

export function GpuInventory({
  gpus,
  onSelect,
  selectedUuid,
}: {
  gpus: GpuIdentity[];
  onSelect: (uuid: string) => void;
  selectedUuid?: string;
}) {
  const [sort, setSort] = useState<GpuSort>({ key: "lastSeen", direction: "desc" });
  const sorted = useMemo(() => sortGpus(gpus, sort), [gpus, sort]);
  const toggleSort = (key: GpuSortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  if (gpus.length === 0) {
    return <p className="empty-chart">No GPUs match the current filter. GPU identities appear once machines have been polled.</p>;
  }

  return (
    <div className="panel table-panel">
      <table>
        <thead>
          <tr>
            <SortableHeader label="GPU" sortKey="uuid" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Type" sortKey="gpuType" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Machine" sortKey="machine" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Slot" sortKey="slot" sort={sort} onSort={toggleSort} align="num" />
            <SortableHeader label="Owner" sortKey="owner" sort={sort} onSort={toggleSort} />
            <SortableHeader label="Placements" sortKey="sightings" sort={sort} onSort={toggleSort} align="num" />
            <SortableHeader label="Last seen" sortKey="lastSeen" sort={sort} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((gpu) => (
            <tr
              key={gpu.uuid}
              className={gpu.uuid === selectedUuid ? "selected" : ""}
              onClick={() => onSelect(gpu.uuid)}
            >
              <td className="name-cell mono" title={gpu.uuid}>{shortUuid(gpu.uuid)}</td>
              <td>{gpu.gpuType || "-"}</td>
              <td>{gpu.lastMachineName || "-"}</td>
              <td className="num">{gpu.lastGpuIndex ?? "-"}</td>
              <td>{gpu.lastOwner || "-"}</td>
              <td className="num">{gpu.sightingCount ?? 1}</td>
              <td className="time-cell">{formatTime(gpu.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sortGpus(gpus: GpuIdentity[], sort: GpuSort): GpuIdentity[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  const text = (value: string | undefined) => (value ?? "").toLowerCase();
  return [...gpus].sort((a, b) => {
    switch (sort.key) {
      case "gpuType":
        return direction * text(a.gpuType).localeCompare(text(b.gpuType), undefined, { numeric: true });
      case "machine":
        return direction * text(a.lastMachineName).localeCompare(text(b.lastMachineName), undefined, { numeric: true });
      case "slot":
        return direction * ((a.lastGpuIndex ?? -1) - (b.lastGpuIndex ?? -1));
      case "owner":
        return direction * text(a.lastOwner).localeCompare(text(b.lastOwner), undefined, { numeric: true });
      case "sightings":
        return direction * ((a.sightingCount ?? 1) - (b.sightingCount ?? 1));
      case "lastSeen":
        return direction * (Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt));
      default:
        return direction * a.uuid.localeCompare(b.uuid);
    }
  });
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: string;
  sortKey: GpuSortKey;
  sort: GpuSort;
  onSort: (key: GpuSortKey) => void;
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
