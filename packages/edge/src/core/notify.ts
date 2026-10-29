/** K-1908: app events, the notifications that an app sends with its notify token. */
import { type NotificationLevel, TEXT_MAX, TITLE_MAX } from "./notifications.ts";

/** K-1908: notifications per card per hour, and for all cards together, so one app cannot starve the others. */
export const NOTIFY_PER_CARD_HOUR = 10;
export const NOTIFY_ALL_HOUR = 30;
/** K-1908: a `/notify` body is at most this many bytes. */
export const NOTIFY_BODY_MAX = 4 * 1024;
export const HOUR_MS = 60 * 60_000;
/** K-1910: a machine that is offline this long opens a notification. */
export const MACHINE_OFFLINE_MS = 15 * 60_000;
/** K-1908: the newest tokens of a card stay valid, so a rollback brings back a build whose token still works. */
export const NOTIFY_TOKENS_KEPT = 6;

export interface AppEvent {
  readonly title: string;
  readonly text: string;
  readonly level: NotificationLevel;
  readonly key: string;
  readonly resolved: boolean;
}

/** K-1908: the body of `POST /notify`, checked; a string says what is wrong. */
export function appEvent(body: unknown): AppEvent | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Send a JSON object.";
  const { title, text, level, key, resolved } = body as Record<string, unknown>;
  if (typeof title !== "string" || title.trim() === "" || title.length > TITLE_MAX)
    return `A title is text of 1 to ${TITLE_MAX} characters.`;
  if (text !== undefined && (typeof text !== "string" || text.length > TEXT_MAX))
    return `A text is at most ${TEXT_MAX} characters.`;
  const chosen = level ?? "info";
  if (chosen !== "info" && chosen !== "warn" && chosen !== "error")
    return "The level is info, warn or error.";
  if (key !== undefined && (typeof key !== "string" || key === "" || key.length > 100))
    return "A key is text of 1 to 100 characters.";
  if (resolved !== undefined && typeof resolved !== "boolean") return "resolved is true or false.";
  return {
    title: title.trim(),
    text: text ?? "",
    level: chosen,
    key: key ?? title.trim(),
    resolved: resolved ?? false,
  };
}

/**
 * K-1908: a window of one hour. With room it records `now` and answers null; when full it answers the seconds until
 * the oldest entry leaves the window. Known limit: the windows live in memory, so a wake starts them again.
 */
export function takeSlot(times: Array<number>, now: number, limit: number): number | null {
  while (times.length > 0 && (times[0] ?? 0) <= now - HOUR_MS) times.shift();
  if (times.length >= limit) return Math.max(1, Math.ceil(((times[0] ?? now) + HOUR_MS - now) / 1000));
  times.push(now);
  return null;
}
