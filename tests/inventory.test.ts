import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSshDestination, readInventoryFromFile, readInventoryText } from "../src/server/inventory";

describe("inventory", () => {
  it("reads headered CSV inventory and trims fields", () => {
    const machines = readInventoryText(
      "name,ip,platform,owner,commission_date,location\n" +
        "alpha,10.0.0.1,gc,ops,2026-01-01,rack-a1\n" +
        "beta,10.0.0.2:2222,n07,research,2026-01-02,\n",
    );

    expect(machines).toEqual([
      {
        name: "alpha",
        ip: "10.0.0.1",
        sshHost: "10.0.0.1",
        sshPort: 22,
        platform: "gc",
        owner: "ops",
        commissionDate: "2026-01-01",
        location: "rack-a1",
      },
      {
        name: "beta",
        ip: "10.0.0.2:2222",
        sshHost: "10.0.0.2",
        sshPort: 2222,
        platform: "n07",
        owner: "research",
        commissionDate: "2026-01-02",
        location: "",
      },
    ]);
  });

  it("reads inventory from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-inventory-"));
    const path = join(dir, "machines.csv");
    writeFileSync(path, "name,ip\nalpha,10.0.0.1\n");

    expect(readInventoryFromFile(path)[0]?.name).toBe("alpha");
  });

  it("parses optional SSH port from IP field", () => {
    expect(parseSshDestination("10.0.0.1")).toEqual({ host: "10.0.0.1", port: 22 });
    expect(parseSshDestination("10.0.0.1:2200")).toEqual({ host: "10.0.0.1", port: 2200 });
  });
});
