import { describe, expect, it } from "vitest";
import { HOUR_MS, appEvent, takeSlot } from "./notify.ts";

describe("app events (K-1908)", () => {
  it("takes a title, a text, a level and a key, and refuses anything else", () => {
    expect(appEvent({ title: "Backup done" })).toEqual({
      title: "Backup done",
      text: "",
      level: "info",
      key: "Backup done",
      resolved: false,
    });
    expect(appEvent({ title: "x".repeat(101) })).toEqual(expect.any(String));
    expect(appEvent({ title: "t", text: "x".repeat(501) })).toEqual(expect.any(String));
    expect(appEvent({ title: "t", level: "fatal" })).toEqual(expect.any(String));
    expect(appEvent([])).toEqual(expect.any(String));
  });

  it("allows 30 in an hour and then names the seconds until the next one", () => {
    const times: Array<number> = [];
    for (let i = 0; i < 30; i++) expect(takeSlot(times, 1_000 + i, 30)).toBeNull();
    expect(takeSlot(times, 2_000, 30)).toBe(HOUR_MS / 1000 - 1);
    expect(takeSlot(times, 1_000 + HOUR_MS, 30)).toBeNull();
  });
});
