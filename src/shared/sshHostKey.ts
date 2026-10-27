export function isChangedHostKeyError(sshError: string | undefined): boolean {
  const normalized = sshError?.toUpperCase() ?? "";
  return normalized.includes("REMOTE HOST IDENTIFICATION HAS CHANGED");
}
