import { readFileSync } from "node:fs";
import type { Machine } from "../shared/types";

export function parseSshDestination(ip: string): { host: string; port: number } {
  const trimmed = ip.trim();
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(trimmed);
  if (!match) {
    return { host: trimmed, port: 22 };
  }

  const port = match[2] === undefined ? 22 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SSH port in ip field: ${ip}`);
  }

  return { host: match[1]!, port };
}

export function readInventoryFromFile(path: string): Machine[] {
  return readInventoryText(readFileSync(path, "utf8"));
}

export function readInventoryText(text: string): Machine[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(parseCsvLine);

  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0]!.map(normalizeHeader);
  const idx = (name: string) => headers.indexOf(normalizeHeader(name));
  const nameIdx = firstIndex(headers, ["name", "hostname", "host"]);
  const ipIdx = idx("ip");

  if (nameIdx < 0 || ipIdx < 0) {
    throw new Error("Inventory CSV must include name and ip columns");
  }

  return rows.slice(1).flatMap((row) => {
    const name = valueAt(row, nameIdx);
    const ip = valueAt(row, ipIdx);
    if (!name && !ip) {
      return [];
    }
    if (!name || !ip) {
      throw new Error(`Inventory row missing name or ip: ${row.join(",")}`);
    }

    const destination = parseSshDestination(ip);
    return [
      {
        name,
        ip,
        sshHost: destination.host,
        sshPort: destination.port,
        platform: valueAt(row, idx("platform")),
        owner: valueAt(row, idx("owner")),
        commissionDate: valueAt(row, firstIndex(headers, ["commission_date", "commissioned_date", "commissioned"])),
        location: valueAt(row, idx("location")),
      },
    ];
  });
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function firstIndex(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = headers.indexOf(normalizeHeader(candidate));
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

function valueAt(row: string[], index: number): string {
  return index >= 0 ? (row[index] ?? "").trim() : "";
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}
