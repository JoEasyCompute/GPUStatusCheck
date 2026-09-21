import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminAccess } from "../src/client/AdminAccess";
import {
  ADMIN_SESSION_KEY,
  adminSessionReducer,
  clearAdminKey,
  initialAdminSessionState,
  isInsecureProtocol,
  loadAdminKey,
  saveAdminKey,
  type StorageLike,
} from "../src/client/adminSession";
import type { AgentOperationDetail } from "../src/shared/types";

describe("admin session", () => {
  it("stores the key only through the supplied tab storage", () => {
    const storage = memoryStorage();

    saveAdminKey(storage, "tab-secret");
    expect(loadAdminKey(storage)).toBe("tab-secret");
    expect(storage.values).toEqual({ [ADMIN_SESSION_KEY]: "tab-secret" });
    clearAdminKey(storage);
    expect(loadAdminKey(storage)).toBe("");
  });

  it("restores into verification and unlocks only after successful verification", () => {
    const verifying = adminSessionReducer(initialAdminSessionState, { type: "restore", key: "tab-secret" });
    expect(verifying).toMatchObject({ mode: "verifying", key: "tab-secret" });

    const unlocked = adminSessionReducer(verifying, { type: "verified" });
    expect(unlocked).toMatchObject({ mode: "unlocked", key: "tab-secret", message: "" });
  });

  it("locks and clears selected machines while preserving the last operation", () => {
    const lastOperation = operationFixture();
    const unlocked = {
      ...initialAdminSessionState,
      mode: "unlocked" as const,
      key: "tab-secret",
      selectedMachineIds: [2, 4],
      lastOperation,
    };

    expect(adminSessionReducer(unlocked, { type: "lock" })).toEqual({
      ...initialAdminSessionState,
      lastOperation,
    });
    expect(adminSessionReducer(unlocked, { type: "unauthorized", message: "key rotated" })).toEqual({
      ...initialAdminSessionState,
      message: "key rotated",
      lastOperation,
    });
  });

  it("enters disabled state without retaining a restored key", () => {
    const verifying = adminSessionReducer(initialAdminSessionState, { type: "restore", key: "tab-secret" });
    expect(adminSessionReducer(verifying, { type: "status", enabled: false })).toMatchObject({ mode: "disabled", key: "" });
  });

  it("derives the insecure warning from the browser protocol", () => {
    expect(isInsecureProtocol("http:")).toBe(true);
    expect(isInsecureProtocol("https:")).toBe(false);
  });

  it("renders locked, verifying, disabled, and transport-aware unlocked states without the raw key", () => {
    const baseProps = { onUnlock: async (_key: string) => {}, onLock: () => {} };
    const locked = renderToStaticMarkup(createElement(AdminAccess, { state: initialAdminSessionState, protocol: "http:", ...baseProps }));
    const verifying = renderToStaticMarkup(createElement(AdminAccess, { state: { ...initialAdminSessionState, mode: "verifying", key: "raw-secret" }, protocol: "http:", ...baseProps }));
    const disabled = renderToStaticMarkup(createElement(AdminAccess, { state: { ...initialAdminSessionState, mode: "disabled" }, protocol: "http:", ...baseProps }));
    const unlockedHttp = renderToStaticMarkup(createElement(AdminAccess, { state: { ...initialAdminSessionState, mode: "unlocked", key: "raw-secret" }, protocol: "http:", ...baseProps }));
    const unlockedHttps = renderToStaticMarkup(createElement(AdminAccess, { state: { ...initialAdminSessionState, mode: "unlocked", key: "raw-secret" }, protocol: "https:", ...baseProps }));

    expect(locked).toContain("Unlock admin");
    expect(verifying).toContain("Verifying admin key");
    expect(disabled).toContain("Admin disabled");
    expect(unlockedHttp).toContain("Admin unlocked");
    expect(unlockedHttp).toContain("plain HTTP");
    expect(unlockedHttps).not.toContain("plain HTTP");
    expect([locked, verifying, disabled, unlockedHttp, unlockedHttps].join(" ")).not.toContain("raw-secret");
  });
});

function memoryStorage(): StorageLike & { values: Record<string, string> } {
  const values: Record<string, string> = {};
  return {
    values,
    getItem(key) { return values[key] ?? null; },
    setItem(key, value) { values[key] = value; },
    removeItem(key) { delete values[key]; },
  };
}

function operationFixture(): AgentOperationDetail {
  return {
    id: 1,
    action: "install",
    status: "failed",
    machineCount: 1,
    succeededCount: 0,
    skippedCount: 0,
    failedCount: 1,
    interruptedCount: 0,
    queuedAt: "2026-09-21T08:00:00.000Z",
    finishedAt: "2026-09-21T08:01:00.000Z",
    items: [],
  };
}
