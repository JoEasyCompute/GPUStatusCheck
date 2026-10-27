import { execFile } from "node:child_process";

export type ClearKnownHost = (host: string, port: number) => Promise<void>;

export function knownHostLookupName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export const clearKnownHost: ClearKnownHost = (host, port) => new Promise((resolve, reject) => {
  const knownHostsName = knownHostLookupName(host, port);
  execFile("ssh-keygen", ["-R", knownHostsName], (error, _stdout, stderr) => {
    if (error) {
      reject(new Error(stderr.trim() || error.message));
      return;
    }
    resolve();
  });
});
