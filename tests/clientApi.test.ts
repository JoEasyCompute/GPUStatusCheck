import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchAdminJson, fetchJson, fetchJsonArray } from "../src/client/api";

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

  it("preserves the HTTP status on API failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "admin authentication required" }, { status: 401 })));

    const error = await fetchJson("/admin").catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "admin authentication required", status: 401 });
  });

  it("adds one bearer credential without mutating existing headers", async () => {
    const originalHeaders = { "Content-Type": "application/json" };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return Response.json({
        authorization: headers.get("Authorization"),
        contentType: headers.get("Content-Type"),
      });
    }));

    await expect(fetchAdminJson<{ authorization: string; contentType: string }>("tab-key", "/admin", {
      method: "POST",
      headers: originalHeaders,
    })).resolves.toEqual({ authorization: "Bearer tab-key", contentType: "application/json" });
    expect(originalHeaders).toEqual({ "Content-Type": "application/json" });
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
