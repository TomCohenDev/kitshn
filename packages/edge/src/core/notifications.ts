/** Section 19: one notification system for every source. */

export type NotificationLevel = "info" | "warn" | "error";

/** K-1904: the sources of this version; a mute names one of them. */
export const NOTIFICATION_SOURCES = ["deploy", "uptime", "kitshn.ask"] as const;

/** K-1903: "run" calls the handler of the source at once; "link" opens a path of the map. */
export type NotificationAction =
  | { readonly id: string; readonly label: string; readonly kind: "run" }
  | { readonly id: string; readonly label: string; readonly kind: "link"; readonly path: string };

/** K-1902: who gets a notification. The owner gets every one; a circle adds the people of that circle. */
export type Recipients = { readonly _tag: "owner" } | { readonly _tag: "circle"; readonly circle: string };

export interface NotificationInput {
  readonly source: string;
  readonly key: string;
  /**
   * K-1905: what this notification is about, for example the id of the failed deploy or the time a card went down.
   * A dismissed notification opens again only for a new episode.
   */
  readonly episode: string;
  readonly card: string | null;
  readonly recipients: Recipients;
  readonly level: NotificationLevel;
  readonly priority: "normal" | "high";
  readonly title: string;
  readonly text: string;
  readonly actions: ReadonlyArray<NotificationAction>;
}

export interface Notification extends NotificationInput {
  readonly id: number;
  /** "open", "closed", "dismissed", or a state of the source (K-1909); only "open" counts on the bell. */
  readonly state: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly snoozedUntil: number | null;
}

/** K-1905: a mute hides the notifications of one card and source, until a time or until unmute (null). */
export interface Mute {
  readonly card: string;
  readonly source: string;
  readonly until: number | null;
}

/** K-1901 */
export const TITLE_MAX = 100;
export const TEXT_MAX = 500;
export const NOTIFICATIONS_KEEP_MS = 30 * 24 * 60 * 60_000;
export const NOTIFICATIONS_MAX = 500;

/** K-1901: a source cannot send more than the limits; a longer text ends with "…". */
export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** K-1905: a notification counts on the bell while it is open and neither muted nor snoozed. */
export function onBell(notification: Notification, mutes: ReadonlyArray<Mute>, now: number): boolean {
  if (notification.state !== "open") return false;
  if (notification.snoozedUntil !== null && notification.snoozedUntil > now) return false;
  return !muted(notification, mutes, now);
}

/** K-1905: a mute of the card and source of a notification holds now. */
export const muted = (notification: Notification, mutes: ReadonlyArray<Mute>, now: number) =>
  mutes.some(
    (mute) =>
      mute.card === notification.card &&
      mute.source === notification.source &&
      (mute.until === null || mute.until > now),
  );

/** True when the notification differs from what a source sends now, so it needs a write (K-1302). */
export const changed = (before: Notification, input: NotificationInput) =>
  before.state !== "open" ||
  before.episode !== input.episode ||
  before.title !== input.title ||
  before.text !== input.text ||
  before.level !== input.level ||
  before.priority !== input.priority ||
  JSON.stringify(before.actions) !== JSON.stringify(input.actions) ||
  JSON.stringify(before.recipients) !== JSON.stringify(input.recipients);
