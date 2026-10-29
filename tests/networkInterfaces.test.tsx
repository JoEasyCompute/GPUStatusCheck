import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NetworkInterfacesSection } from "../src/client/NetworkInterfacesSection";

describe("network interface details", () => {
  it("shows interface identity with source and observation time", () => {
    const markup = renderToStaticMarkup(createElement(NetworkInterfacesSection, {
      snapshots: [
        { source: "probe", observedAt: "2026-10-27T10:00:00Z", bmcIpAddress: "192.168.20.42", interfaces: [{ name: "ens3", macAddress: "52:54:00:12:34:56", ipAddresses: ["10.0.0.5/24"], state: "up" }] },
        { source: "agent", observedAt: "2026-10-27T10:01:00Z", bmcIpAddress: "192.168.20.42", interfaces: [{ name: "ens3", macAddress: "52:54:00:12:34:56", ipAddresses: ["10.0.0.5/24"], state: "up" }] },
      ],
    }));

    expect(markup).toContain("Network interfaces (2)");
    expect(markup).toContain("52:54:00:12:34:56");
    expect(markup).toContain("10.0.0.5/24");
    expect(markup).toContain("SSH");
    expect(markup).toContain("Agent");
    expect(markup).toContain("10:01:00 AM");
    expect(markup).toContain("BMC IP");
    expect(markup).toContain("192.168.20.42");
    expect(markup).toContain('aria-label="Copy ens3 MAC address from SSH" title="Click to copy ens3 MAC address from SSH">52:54:00:12:34:56</button>');
    expect(markup).toContain('aria-label="Copy BMC IP from SSH" title="Click to copy BMC IP from SSH">192.168.20.42</button>');
    expect(markup).toContain('aria-label="Copy BMC IP from Agent" title="Click to copy BMC IP from Agent">192.168.20.42</button>');
    expect(markup).not.toContain(">Copy</button>");
  });

  it("explains when no interface snapshot has been recorded", () => {
    const markup = renderToStaticMarkup(createElement(NetworkInterfacesSection, { snapshots: [] }));
    expect(markup).toContain("No network interface snapshot has been recorded.");
  });
});
