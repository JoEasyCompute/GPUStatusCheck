import { formatWattsCompact } from "./formatters";
import type { MachineGroupStats } from "./machineGroups";

export function GroupStats({ stats }: { stats: MachineGroupStats }) {
  return (
    <span className="group-stats">
      <span className="grp-count">{stats.total} machine{stats.total === 1 ? "" : "s"}</span>
      <span className="grp ok" title="OK"><i />{stats.ok}</span>
      <span className="grp degraded" title="Degraded"><i />{stats.degraded}</span>
      <span className="grp failed" title="SSH failed"><i />{stats.sshFailed}</span>
      {stats.totalPowerW > 0 ? <span title="Total group power">Σ {formatWattsCompact(stats.totalPowerW)}</span> : null}
      {stats.averagePowerW !== null ? <span title="Average power per machine">avg {formatWattsCompact(stats.averagePowerW)}</span> : null}
      {stats.averageTempC !== null ? <span title="Average GPU temperature">{stats.averageTempC.toFixed(1)} °C</span> : null}
    </span>
  );
}
