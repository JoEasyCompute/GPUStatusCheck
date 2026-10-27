import { describe, expect, it } from "vitest";
import { knownHostLookupName } from "../src/server/knownHosts";

describe("known host lookup names", () => {
  it("uses OpenSSH's bracketed endpoint format for non-default ports", () => {
    expect(knownHostLookupName("10.0.0.1", 63001)).toBe("[10.0.0.1]:63001");
  });

  it("uses the plain host name for the default SSH port", () => {
    expect(knownHostLookupName("10.0.0.1", 22)).toBe("10.0.0.1");
  });
});
