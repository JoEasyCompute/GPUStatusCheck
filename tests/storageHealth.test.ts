import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStorageHealth } from "../src/server/storageHealth";

describe("storage health", () => {
  it("reports database size and filesystem free space", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-storage-health-"));
    const dbPath = join(dir, "db.sqlite");
    writeFileSync(dbPath, Buffer.alloc(1_234));

    const health = await readStorageHealth(dbPath, 5_000);

    expect(health).toMatchObject({ databaseBytes: 1_234, minimumFreeDiskBytes: 5_000 });
    expect(health.freeDiskBytes).toBeGreaterThan(0);
    expect(health.error).toBeUndefined();
  });

  it("exposes measurements that identify a breached threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-storage-threshold-"));
    const dbPath = join(dir, "db.sqlite");
    writeFileSync(dbPath, "db");

    const health = await readStorageHealth(dbPath, Number.MAX_SAFE_INTEGER);

    expect(health.freeDiskBytes).not.toBeNull();
    expect(health.freeDiskBytes!).toBeLessThan(health.minimumFreeDiskBytes);
  });

  it("treats an in-memory database as unavailable storage telemetry", async () => {
    await expect(readStorageHealth(":memory:", 5_000)).resolves.toEqual({
      databaseBytes: null,
      freeDiskBytes: null,
      minimumFreeDiskBytes: 5_000,
    });
  });

  it("reports free space from the nearest existing parent of a missing database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-storage-missing-"));

    const health = await readStorageHealth(join(dir, "nested", "db.sqlite"), 5_000);

    expect(health.databaseBytes).toBeNull();
    expect(health.freeDiskBytes).toBeGreaterThan(0);
    expect(health.error).toBeUndefined();
  });

  it("returns unknown metrics instead of throwing when filesystem statistics fail", async () => {
    const health = await readStorageHealth("/unavailable/db.sqlite", 5_000, {
      stat: async () => {
        throw Object.assign(new Error("stat denied"), { code: "EACCES" });
      },
      statfs: async () => {
        throw Object.assign(new Error("statfs denied"), { code: "EACCES" });
      },
    });

    expect(health).toEqual({
      databaseBytes: null,
      freeDiskBytes: null,
      minimumFreeDiskBytes: 5_000,
      error: "statfs denied",
    });
  });
});
