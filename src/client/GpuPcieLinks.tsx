import type { GpuMetric } from "../shared/types";

export function GpuPcieLinks({ metrics }: { metrics: GpuMetric[] }) {
  const hasReadings = metrics.some((metric) =>
    metric.pcieLinkSpeedGtps != null || metric.pcieMaxLinkSpeedGtps != null
    || metric.pcieLinkWidth != null || metric.pcieMaxLinkWidth != null,
  );

  return (
    <details className="detail-section">
      <summary>GPU PCIe links</summary>
      {hasReadings ? (
        <div className="network-interface-scroll">
          <p>Negotiated link speed can fall while a GPU is idle.</p>
          <table className="network-interface-table">
            <thead>
              <tr>
                <th>GPU</th>
                <th>PCI address</th>
                <th>Current width</th>
                <th>Maximum width</th>
                <th>Current speed</th>
                <th>Maximum speed</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.gpuIndex}>
                  <td>GPU {metric.gpuIndex}</td>
                  <td>{metric.pciBusId || "—"}</td>
                  <td>{metric.pcieLinkWidth == null ? "—" : `×${metric.pcieLinkWidth}`}</td>
                  <td>{metric.pcieMaxLinkWidth == null ? "—" : `×${metric.pcieMaxLinkWidth}`}</td>
                  <td>{metric.pcieLinkSpeedGtps == null ? "—" : `${metric.pcieLinkSpeedGtps} GT/s`}</td>
                  <td>{metric.pcieMaxLinkSpeedGtps == null ? "—" : `${metric.pcieMaxLinkSpeedGtps} GT/s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p>No PCIe link readings available.</p>}
    </details>
  );
}
