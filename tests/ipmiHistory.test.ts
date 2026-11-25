import { expect, it } from "vitest";
import { createDatabase } from "../src/server/db";

it("stores IPMI power for each successful probe and leaves unavailable samples empty", () => {
  const db = createDatabase(":memory:");
  try {
    db.migrate();
    const machine = db.upsertMachine({ name: "alpha", ip: "10.0.0.1" });
    const run = db.createPollRun(1);
    const probe = { name: machine.name, ip: machine.ip, status: "ok", sshOk: true } as const;
    const missingId = db.insertProbeResult(run, machine.id!, probe);
    const zeroId = db.insertProbeResult(run, machine.id!, { ...probe, ipmiPowerW: 0 });
    const powerId = db.insertProbeResult(run, machine.id!, { ...probe, ipmiPowerW: 425 });
    const failedId = db.insertProbeResult(run, machine.id!, { ...probe, status: "ssh_failed", sshOk: false });
    const history = new Map(db.listHistory(machine.id!).map((sample) => [sample.id, sample.ipmiPowerW]));
    expect(history.size).toBe(4);
    expect(history.get(missingId)).toBeUndefined();
    expect(history.get(zeroId)).toBe(0);
    expect(history.get(powerId)).toBe(425);
    expect(history.get(failedId)).toBeUndefined();
  } finally {
    db.close();
  }
});

it("adds chassis power history to an existing probe table without changing older samples", () => {
  const db = createDatabase(":memory:");
  try {
    db.migrate();
    const machine = db.upsertMachine({ name: "alpha", ip: "10.0.0.1" });
    const run = db.createPollRun(1);
    const probe = { name: machine.name, ip: machine.ip, status: "ok", sshOk: true } as const;
    db.insertProbeResult(run, machine.id!, { ...probe, gpuPowerW: "200" });
    db.raw.exec("ALTER TABLE probe_results DROP COLUMN ipmi_power_w");

    db.migrate();
    expect(db.listHistory(machine.id!)[0]).toMatchObject({ gpuPowerW: "200.0", ipmiPowerW: undefined });
    db.insertProbeResult(run, machine.id!, { ...probe, ipmiPowerW: 425 });
    expect(db.listHistory(machine.id!).some((sample) => sample.ipmiPowerW === 425)).toBe(true);
  } finally {
    db.close();
  }
});
