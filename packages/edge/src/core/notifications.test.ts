import { describe, expect, it } from "vitest";
import { type Notification, changed, clip, onBell } from "./notifications.ts";

const open: Notification = {
  id: 1,
  source: "deploy",
  key: "shop",
  card: "shop",
  recipients: { _tag: "owner" },
  level: "error",
  priority: "normal",
  title: "Deploy of shop failed",
  text: "The build failed.",
  actions: [],
  state: "open",
  openedAt: 0,
  closedAt: null,
  snoozedUntil: null,
};

describe("notifications (K-1901, K-1905)", () => {
  it("shows an open notification on the bell until a mute or a snooze hides it, and never a closed one", () => {
    expect(onBell(open, [], 10)).toBe(true);
    expect(onBell({ ...open, state: "closed" }, [], 10)).toBe(false);
    expect(onBell({ ...open, snoozedUntil: 20 }, [], 10)).toBe(false);
    expect(onBell({ ...open, snoozedUntil: 5 }, [], 10)).toBe(true);
    expect(onBell(open, [{ card: "shop", source: "deploy", until: null }], 10)).toBe(false);
    expect(onBell(open, [{ card: "shop", source: "deploy", until: 5 }], 10)).toBe(true);
    expect(onBell(open, [{ card: "shop", source: "uptime", until: null }], 10)).toBe(true);
  });

  it("writes only when a source sends something new", () => {
    expect(changed(open, open)).toBe(false);
    expect(changed(open, { ...open, text: "Another reason." })).toBe(true);
    expect(changed({ ...open, state: "closed" }, open)).toBe(true);
  });

  it("clips a long text to its limit", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });
});
