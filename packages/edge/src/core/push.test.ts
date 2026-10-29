import { describe, expect, it } from "vitest";
import type { Notification } from "./notifications.ts";
import { deviceWants, isQuiet, pushMessage } from "./push.ts";

const notification: Notification = {
  id: 7,
  source: "uptime",
  key: "riffle",
  episode: "1",
  card: "riffle",
  recipients: { _tag: "owner" },
  level: "warn",
  priority: "normal",
  title: "riffle is down",
  text: "kitshn gets no good answer from riffle.example.com.",
  actions: [],
  state: "open",
  openedAt: 0,
  closedAt: null,
  snoozedUntil: null,
};
// 2026-10-28 23:30 in Jerusalem (UTC+2).
const night = Date.parse("2026-10-28T21:30:00Z");
const quiet = { start: 22 * 60, end: 7 * 60, timeZone: "Asia/Jerusalem" };

describe("Web Push (K-1907)", () => {
  it("keeps quiet hours in the time zone of the device, also over midnight", () => {
    expect(isQuiet(quiet, night)).toBe(true);
    expect(isQuiet(quiet, Date.parse("2026-10-28T10:00:00Z"))).toBe(false);
    expect(
      isQuiet({ start: 9 * 60, end: 17 * 60, timeZone: "UTC" }, Date.parse("2026-10-28T10:00:00Z")),
    ).toBe(true);
    expect(isQuiet(null, night)).toBe(false);
  });

  it("lets only error and priority high through quiet hours, and never a level the device left out", () => {
    const device = { levels: ["warn", "error"] as const, quiet };
    expect(deviceWants(device, notification, night)).toBe(false);
    expect(deviceWants(device, { ...notification, level: "error" }, night)).toBe(true);
    expect(deviceWants(device, { ...notification, priority: "high" }, night)).toBe(true);
    expect(deviceWants({ levels: ["error"], quiet: null }, notification, night)).toBe(false);
    expect(
      deviceWants({ levels: ["error"], quiet: null }, { ...notification, priority: "high" }, night),
    ).toBe(true);
  });

  it("carries no address or reason text to the push service", () => {
    const message = JSON.stringify(pushMessage(notification, "riffle"));
    expect(message).not.toContain("example.com");
    expect(message).not.toContain(notification.text);
    expect(pushMessage(notification, "riffle")).toMatchObject({
      title: "riffle is down",
      body: "uptime · riffle",
    });
  });
});
