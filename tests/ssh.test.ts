import { describe, expect, it } from "vitest";
import { buildSshCommand } from "../src/shared/ssh";

describe("ssh command builder", () => {
  it("builds a default-port SSH command", () => {
    expect(buildSshCommand({ name: "alpha", ip: "10.0.0.1", sshHost: "10.0.0.1", sshPort: 22 }, "ezc")).toBe("ssh ezc@10.0.0.1");
  });

  it("builds a custom-port SSH command", () => {
    expect(buildSshCommand({ name: "alpha", ip: "185.61.165.201:63001", sshHost: "185.61.165.201", sshPort: 63001 }, "ezc")).toBe(
      "ssh -p 63001 ezc@185.61.165.201",
    );
  });

  it("quotes unusual shell tokens", () => {
    expect(buildSshCommand({ name: "alpha", ip: "host name", sshHost: "host name", sshPort: 22 }, "ops user")).toBe("ssh 'ops user'@'host name'");
  });
});
