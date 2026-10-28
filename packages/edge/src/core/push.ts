/** K-1907: the rules of Web Push for notifications, pure so the UI and the tests share them. */
import type { Notification, NotificationLevel } from "./notifications.ts";

/** Quiet hours: minutes after midnight in the browser's time zone; `start` after `end` runs over midnight. */
export interface QuietHours {
  readonly start: number;
  readonly end: number;
  readonly timeZone: string;
}

/** One subscribed browser as the map lists it; the endpoint and keys never leave the Durable Object. */
export interface PushDevice {
  readonly id: number;
  readonly label: string;
  readonly email: string;
  readonly levels: ReadonlyArray<NotificationLevel>;
  readonly quiet: QuietHours | null;
  readonly createdAt: number;
  /** The time of the last push that the push service took, or null before the first. */
  readonly lastOkAt: number | null;
}

export const DEFAULT_LEVELS: ReadonlyArray<NotificationLevel> = ["warn", "error"];
/** K-1907: "Send a test" runs at most once in this time. */
export const PUSH_TEST_MS = 60_000;

/** The minutes after midnight of `now` in `timeZone`. A time zone that Intl does not know fails (K-006). */
export function minutesIn(timeZone: string, now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date(now))
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return Number(parts["hour"]) * 60 + Number(parts["minute"]);
}

export function isQuiet(quiet: QuietHours | null, now: number): boolean {
  if (quiet === null || quiet.start === quiet.end) return false;
  const minute = minutesIn(quiet.timeZone, now);
  return quiet.start < quiet.end
    ? minute >= quiet.start && minute < quiet.end
    : minute >= quiet.start || minute < quiet.end;
}

/** K-1907: a device gets a notification of a level it chose; in quiet hours only "error" and priority high. */
export function deviceWants(
  device: Pick<PushDevice, "levels" | "quiet">,
  notification: Notification,
  now: number,
) {
  if (notification.priority !== "high" && !device.levels.includes(notification.level)) return false;
  const urgent = notification.level === "error" || notification.priority === "high";
  return urgent || !isQuiet(device.quiet, now);
}

/** K-1907: what the push service carries, encrypted: never an address, a reason text or a secret. */
export function pushMessage(notification: Notification, cardName: string | null) {
  return {
    title: notification.title,
    body: cardName === null ? notification.source : `${notification.source} · ${cardName}`,
    id: notification.id,
    tag: `${notification.source}:${notification.key}`,
    path: "/#notifications",
  };
}
