import type { Machine } from "./types";

export function buildSshCommand(machine: Machine, user: string): string {
  const host = machine.sshHost || machine.ip;
  const port = machine.sshPort ?? 22;
  const target = `${shellToken(user)}@${shellToken(host)}`;
  return port === 22 ? `ssh ${target}` : `ssh -p ${port} ${target}`;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9._:@/-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
