import { describe, expect, it } from "vitest";
import { openLink } from "./invite.ts";

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
