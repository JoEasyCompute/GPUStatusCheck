import { createHash, timingSafeEqual } from "node:crypto";

export type AdminAuthState = "disabled" | "unauthorized" | "authenticated";

export function verifyAdminAuthorization(configuredKey: string, authorization?: string): AdminAuthState {
  if (!configuredKey) {
    return "disabled";
  }
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!presented) {
    return "unauthorized";
  }
  return timingSafeEqual(digest(configuredKey), digest(presented)) ? "authenticated" : "unauthorized";
}

export function adminKeyWarning(configuredKey: string): string | undefined {
  if (!configuredKey || Buffer.byteLength(configuredKey, "utf8") >= 32) {
    return undefined;
  }
  return "GPUCHECK_ADMIN_API_KEY should contain at least 32 bytes of random data";
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
