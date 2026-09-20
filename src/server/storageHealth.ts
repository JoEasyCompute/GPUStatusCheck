import { stat, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { StorageHealth } from "../shared/types";

type StorageHealthFs = {
  stat(path: string): Promise<{ size: number }>;
  statfs(path: string): Promise<{ bavail: number; bsize: number }>;
};

const defaultFs: StorageHealthFs = { stat, statfs };

export async function readStorageHealth(
  dbPath: string,
  minimumFreeDiskBytes: number,
  fs: StorageHealthFs = defaultFs,
): Promise<StorageHealth> {
  if (dbPath === ":memory:") {
    return { databaseBytes: null, freeDiskBytes: null, minimumFreeDiskBytes };
  }

  const resolvedDbPath = resolve(dbPath);
  let databaseBytes: number | null = null;
  let filesystemPath = dirname(resolvedDbPath);
  try {
    databaseBytes = (await fs.stat(resolvedDbPath)).size;
    filesystemPath = resolvedDbPath;
  } catch {
    // A database may not exist until first startup; measure its nearest
    // existing parent without making missing telemetry fatal.
  }
  try {
    const disk = await statNearestFilesystem(filesystemPath, fs);
    return {
      databaseBytes,
      freeDiskBytes: disk.bavail * disk.bsize,
      minimumFreeDiskBytes,
    };
  } catch (error) {
    return {
      databaseBytes,
      freeDiskBytes: null,
      minimumFreeDiskBytes,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function statNearestFilesystem(path: string, fs: StorageHealthFs): Promise<{ bavail: number; bsize: number }> {
  let current = path;
  while (true) {
    try {
      return await fs.statfs(current);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
