import type { NetworkInterfaceSnapshot } from "../shared/types";
import { formatTime } from "./formatters";

export function NetworkInterfacesSection({ snapshots }: { snapshots: NetworkInterfaceSnapshot[] }) {
  const interfaces = snapshots.flatMap((snapshot) => snapshot.interfaces.map((iface) => ({
    ...iface,
    source: snapshot.source,
    observedAt: snapshot.observedAt,
  })));
  return (
    <details className="detail-section network-interfaces-section">
      <summary>Network interfaces ({interfaces.length})</summary>
      {snapshots.length === 0 ? <p>No network interface snapshot has been recorded.</p> : interfaces.length === 0 ? (
        <>
          <p>No matching network interfaces were reported.</p>
          <BmcAddresses snapshots={snapshots} />
        </>
      ) : (
        <div className="network-interface-scroll">
          <BmcAddresses snapshots={snapshots} />
          <table className="network-interface-table">
            <thead>
              <tr>
                <th>Interface</th>
                <th>MAC address</th>
                <th>IP addresses</th>
                <th>Link</th>
                <th>Source</th>
                <th>Observed</th>
              </tr>
            </thead>
            <tbody>
              {interfaces.map((iface) => (
                <tr key={`${iface.source}-${iface.name}`}>
                  <td>{iface.name}</td>
                  <td className="interface-mac">{iface.macAddress || "-"}</td>
                  <td>{iface.ipAddresses.join(", ") || "-"}</td>
                  <td>{iface.state || "unknown"}</td>
                  <td>{iface.source === "probe" ? "SSH" : "Agent"}</td>
                  <td>{formatTime(iface.observedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function BmcAddresses({ snapshots }: { snapshots: NetworkInterfaceSnapshot[] }) {
  return (
    <div className="bmc-address-list">
      {snapshots.map((snapshot) => (
        <div className="bmc-address-row" key={snapshot.source}>
          <strong>BMC IP · {snapshot.source === "probe" ? "SSH" : "Agent"}</strong>
          <code>{snapshot.bmcIpAddress || "Not reported"}</code>
          <span>Observed {formatTime(snapshot.observedAt)}</span>
        </div>
      ))}
    </div>
  );
}
