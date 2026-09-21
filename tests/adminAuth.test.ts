import { describe, expect, it } from "vitest";
import { adminKeyWarning, verifyAdminAuthorization } from "../src/server/adminAuth";

describe("admin authentication", () => {
  it("disables authentication when no server key exists", () => {
    expect(verifyAdminAuthorization("", undefined)).toBe("disabled");
  });

  it("rejects missing, malformed, and incorrect bearer credentials", () => {
    expect(verifyAdminAuthorization("secret", undefined)).toBe("unauthorized");
    expect(verifyAdminAuthorization("secret", "Basic secret")).toBe("unauthorized");
    expect(verifyAdminAuthorization("secret", "Bearer wrong")).toBe("unauthorized");
  });

  it("accepts exact ASCII and Unicode bearer credentials", () => {
    expect(verifyAdminAuthorization("secret", "Bearer secret")).toBe("authenticated");
    expect(verifyAdminAuthorization("🔐-secret", "Bearer 🔐-secret")).toBe("authenticated");
  });

  it("compares different-length credentials without throwing", () => {
    expect(() => verifyAdminAuthorization("short", "Bearer a-much-longer-value")).not.toThrow();
    expect(verifyAdminAuthorization("short", "Bearer a-much-longer-value")).toBe("unauthorized");
  });

  it("warns only when a configured key is shorter than 32 UTF-8 bytes", () => {
    expect(adminKeyWarning("")).toBeUndefined();
    expect(adminKeyWarning("short")).toContain("at least 32 bytes");
    expect(adminKeyWarning("x".repeat(32))).toBeUndefined();
    expect(adminKeyWarning("🔐".repeat(8))).toBeUndefined();
  });
});
