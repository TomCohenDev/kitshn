import { describe, expect, it } from "vitest";
import { logArgs, logRange, sinceMs } from "./logs.ts";

describe("kitshn logs (K-1809)", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const range = (since: string, from = "", to = "") => logRange({ since, from, to }, now);

  it("reads --since in minutes, hours and days, and refuses any other form", () => {
    expect(sinceMs("15m")).toBe(900_000);
    expect(sinceMs("2d")).toBe(172_800_000);
    for (const text of ["", "1", "h", "0h", "-1h", "1.5h", "1w"]) expect(sinceMs(text)).toBeNull();
  });

  it("takes the last hour by default, a --from with an optional --to, and refuses mixed or reversed ranges", () => {
    expect(range("")).toEqual({ from: now - 3_600_000, to: now });
    expect(range("", "2026-10-28T10:00:00Z")).toEqual({ from: Date.parse("2026-10-28T10:00:00Z"), to: now });
    expect(range("1h", "2026-10-28T10:00:00Z")).toMatch(/not both/);
    expect(range("", "", "2026-10-28T10:00:00Z")).toMatch(/needs --from/);
    expect(range("", "2026-10-28T11:00:00Z", "2026-10-28T10:00:00Z")).toMatch(/before --to/);
    expect(range("", "yesterday")).toMatch(/take a time/);
  });

  it("takes the card and the text, skips flag values, and keeps text after -- as it is", () => {
    expect(logArgs(["app-x", "boom", "--since", "1h", "--json"])).toEqual({ card: "app-x", text: "boom" });
    expect(logArgs(["--server", "https://kit.example.com", "app-x"])).toEqual({ card: "app-x", text: "" });
    expect(logArgs(["app-x", "--since", "1h", "--", "--verbose", "mode"])).toEqual({
      card: "app-x",
      text: "--verbose mode",
    });
  });
});
