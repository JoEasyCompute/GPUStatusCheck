import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, fetchJsonArray } from "../src/client/api";

describe("client API response handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns successful JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ value: 1 })));

    await expect(fetchJson<{ value: number }>("/ok")).resolves.toEqual({ value: 1 });
  });

  it("reports the server error from failed JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "poll failed" }, { status: 500 })));

    await expect(fetchJson("/bad")).rejects.toThrow("poll failed");
  });

  it("reports HTTP status when a failed response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", {
      status: 503,
      statusText: "Service Unavailable",
    })));

    await expect(fetchJson("/plain-error")).rejects.toThrow("503 Service Unavailable");
  });

  it("rejects object payloads where an array is required", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "not an array" })));

    await expect(fetchJsonArray("/object")).rejects.toThrow("Expected an array response");
  });
});
