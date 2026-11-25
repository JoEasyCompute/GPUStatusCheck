import { useState, type MouseEvent } from "react";
import type { NetworkInterface, NetworkInterfaceSnapshot } from "../shared/types";
import { copyText } from "./clipboard";
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
                <th>Public IPv4</th>
                <th>Link</th>
                <th>Speed</th>
                <th>RX errors / drops</th>
                <th>TX errors / drops</th>
                <th>Source</th>
                <th>Observed</th>
              </tr>
            </thead>
            <tbody>
              {interfaces.map((iface) => (
                <tr key={`${iface.source}-${iface.name}`}>
                  <td>{iface.name}</td>
                  <td className="interface-mac">
                    {iface.macAddress
                      ? <CopyValueButton value={iface.macAddress} label={`${iface.name} MAC address from ${iface.source === "probe" ? "SSH" : "Agent"}`} />
                      : "-"}
                  </td>
                  <td>{iface.ipAddresses.join(", ") || "-"}</td>
                  <td>{iface.publicIpv4
                    ? <CopyValueButton value={iface.publicIpv4} label={`${iface.name} public IPv4`} />
                    : "-"}</td>
                  <td>{iface.state || "unknown"}</td>
                  <td>{iface.speedMbps === undefined ? "-" : `${iface.speedMbps} Mbps`}</td>
                  <td><NicCountersCell iface={iface} errors="rxErrors" dropped="rxDropped" /></td>
                  <td><NicCountersCell iface={iface} errors="txErrors" dropped="txDropped" /></td>
                  <td>{iface.source === "probe" ? "SSH" : "Agent"}</td>
                  <td>{formatTime(iface.observedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {interfaces.some((iface) => iface.counterDeltas) && <p>Parentheses show the change since the previous snapshot.</p>}
        </div>
      )}
    </details>
  );
}

function NicCountersCell({ iface, errors, dropped }: {
  iface: NetworkInterface;
  errors: "rxErrors" | "txErrors";
  dropped: "rxDropped" | "txDropped";
}) {
  function format(key: typeof errors | typeof dropped) {
    const total = iface.counters?.[key];
    const delta = iface.counterDeltas?.[key];
    if (total === undefined) return "-";
    return delta === undefined ? total : `${total} (+${delta})`;
  }
  return <>{format(errors)} / {format(dropped)}</>;
}

function BmcAddresses({ snapshots }: { snapshots: NetworkInterfaceSnapshot[] }) {
  return (
    <div className="bmc-address-list">
      {snapshots.map((snapshot) => (
        <div className="bmc-address-row" key={snapshot.source}>
          <strong>BMC IP · {snapshot.source === "probe" ? "SSH" : "Agent"}</strong>
          {snapshot.bmcIpAddress
            ? <CopyValueButton value={snapshot.bmcIpAddress} label={`BMC IP from ${snapshot.source === "probe" ? "SSH" : "Agent"}`} />
            : <span>Not reported</span>}
          <span>Observed {formatTime(snapshot.observedAt)}</span>
        </div>
      ))}
    </div>
  );
}

function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    try {
      await copyText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1500);
  }

  return (
    <button type="button" className="copy-value" aria-label={`Copy ${label}`} title={`Click to copy ${label}`} onClick={(event) => void copy(event)}>
      {value}
      {state !== "idle" ? <span className="copy-feedback" aria-live="polite">{state === "copied" ? "Copied" : "Copy failed"}</span> : null}
    </button>
  );
}
