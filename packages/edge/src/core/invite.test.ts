import { describe, expect, it } from "vitest";
import { inviteClients, openLink } from "./invite.ts";

describe("open links of client apps (K-720)", () => {
  it("puts the encoded invite link in each slot, with its # as %23", () => {
    expect(
      openLink(
        "t3code://connections/new?inviteUrl={inviteUrl}",
        "https://kit.example.com/join/device#code=00ff",
      ),
    ).toBe("t3code://connections/new?inviteUrl=https%3A%2F%2Fkit.example.com%2Fjoin%2Fdevice%23code%3D00ff");
    expect(openLink("x://a?u={inviteUrl}&v={inviteUrl}", "a#b")).toBe("x://a?u=a%23b&v=a%23b");
  });
});

describe("client apps of all machines (K-720)", () => {
  const fork = {
    id: "t3code-fork",
    name: "T3 Code (fork)",
    open: "t3code-preview://n?u={inviteUrl}",
    install: [],
  };
  const other = { ...fork, open: "evil://n?u={inviteUrl}" };

  it("merges equal declarations with their machines, and agrees", () => {
    expect(
      inviteClients([
        { machine: "vps", provider: "t3", clients: [fork] },
        { machine: "mac", provider: "t3", clients: [fork] },
        { machine: "pc", provider: "t3", clients: [] },
      ]),
    ).toEqual({ clients: [{ ...fork, provider: "t3", machines: ["vps", "mac"] }], agree: true });
  });

  it("keeps a client of the same id with another open link apart, and disagrees", () => {
    expect(
      inviteClients([
        { machine: "evil", provider: "t3", clients: [other] },
        { machine: "vps", provider: "t3", clients: [fork] },
      ]),
    ).toEqual({
      clients: [
        { ...other, provider: "t3", machines: ["evil"] },
        { ...fork, provider: "t3", machines: ["vps"] },
      ],
      agree: false,
    });
  });
});
