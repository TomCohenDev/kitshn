import { useEffect, useState } from "preact/hooks";
import type { State } from "../core/model.ts";
import { type Mute, type Notification, onBell } from "../core/notifications.ts";
import { Menu, MenuItem } from "./controls.tsx";
import type { Rect } from "./popover.ts";
import { callApi } from "./store.ts";

const HOUR = 60 * 60_000;

/** K-1905: a mute lasts 1 hour, 1 day or until unmute. */
const MUTES = [
  { label: "For 1 hour", ms: HOUR, tip: "for one hour" },
  { label: "For 1 day", ms: 24 * HOUR, tip: "for one day" },
  { label: "Until unmute", ms: null, tip: "until you unmute them" },
] as const;

/** K-1905: the notifications of the last 30 days, with Mute, Snooze, Unmute and the actions of each source. */
export function NotificationsView(props: {
  state: State;
  /** The open count of the snapshot; the list loads again when it changes. */
  bell: number;
  onToast: (text: string, error: boolean) => void;
}) {
  const [list, setList] = useState<{
    notifications: ReadonlyArray<Notification>;
    mutes: ReadonlyArray<Mute>;
  } | null>(null);
  const [version, setVersion] = useState(0);
  /** The open Mute menu: its notification and the button it hangs from. */
  const [muting, setMuting] = useState<{ readonly notification: Notification; readonly anchor: Rect } | null>(
    null,
  );

  useEffect(() => {
    void callApi<{ notifications: Array<Notification>; mutes: Array<Mute> }>(
      "GET",
      "/api/notifications",
    ).then((result) => {
      if ("error" in result) props.onToast(result.error, true);
      else setList(result);
    });
  }, [props.bell, version]);

  const post = async (path: string, body: object, done: string) => {
    const result = await callApi<{ ok: true }>("POST", path, body);
    if ("error" in result) props.onToast(result.error, true);
    else {
      props.onToast(done, false);
      setVersion((each) => each + 1);
    }
  };
  const cardName = (id: string | null) => (id === null ? null : (props.state.resources.get(id)?.name ?? id));
  const now = Date.now();

  return (
    <div class="table-view notifications-view">
      <p class="muted">
        What kitshn told you in the last 30 days. Mute and Snooze hide a notification from the bell; they
        never answer it.
      </p>
      {muting ? (
        <Menu label="Mute" anchor={muting.anchor} onClose={() => setMuting(null)}>
          {MUTES.map((mute) => (
            <MenuItem
              key={mute.label}
              tip={`Hide the ${muting.notification.source} notifications of ${cardName(muting.notification.card)} ${mute.tip}.`}
              onSelect={() =>
                void post(
                  "/api/notifications/mute",
                  {
                    card: muting.notification.card,
                    source: muting.notification.source,
                    until: mute.ms === null ? null : now + mute.ms,
                  },
                  `Muted ${muting.notification.source} of ${cardName(muting.notification.card)} ${mute.tip}.`,
                )
              }
            >
              {mute.label}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      {list === null ? <p class="muted">Reading the notifications…</p> : null}
      {list && list.notifications.length === 0 ? (
        <p class="muted">No notification in the last 30 days.</p>
      ) : null}
      {list?.notifications.map((notification) => {
        const shown = onBell(notification, list.mutes, now);
        const card = cardName(notification.card);
        return (
          <article
            key={notification.id}
            class={`notification level-${notification.level}${shown ? "" : " quiet"}`}
          >
            <div class="notification-head">
              <strong>{notification.title}</strong>
              <span
                class={`sticker${notification.state === "open" ? (notification.level === "error" ? "" : " wait") : " ok"}`}
              >
                {notification.state}
              </span>
            </div>
            <p>{notification.text}</p>
            <p class="muted">
              {notification.source}
              {card ? ` · ${card}` : ""} · opened {new Date(notification.openedAt).toLocaleString()}
              {notification.closedAt ? ` · closed ${new Date(notification.closedAt).toLocaleString()}` : ""}
              {notification.snoozedUntil && notification.snoozedUntil > now
                ? ` · snoozed until ${new Date(notification.snoozedUntil).toLocaleString()}`
                : ""}
            </p>
            <div class="row">
              {notification.actions.map((action) =>
                action.kind === "link" ? (
                  <a key={action.id} class="btn" href={action.path}>
                    {action.label}
                  </a>
                ) : (
                  <button
                    key={action.id}
                    class="btn"
                    onClick={() =>
                      void post(
                        `/api/notifications/${notification.id}/actions/${action.id}`,
                        {},
                        `${action.label}: done.`,
                      )
                    }
                  >
                    {action.label}
                  </button>
                ),
              )}
              {notification.state === "open" ? (
                notification.snoozedUntil !== null && notification.snoozedUntil > now ? (
                  <button
                    class="btn"
                    data-tip="Show this notification on the bell again now."
                    onClick={() =>
                      void post(`/api/notifications/${notification.id}/snooze`, { until: null }, "Unsnoozed.")
                    }
                  >
                    Unsnooze
                  </button>
                ) : (
                  <button
                    class="btn"
                    data-tip="Hide this notification from the bell for one hour. It stays open."
                    onClick={() =>
                      void post(
                        `/api/notifications/${notification.id}/snooze`,
                        { until: now + HOUR },
                        "Snoozed for 1 hour.",
                      )
                    }
                  >
                    Snooze 1 h
                  </button>
                )
              ) : null}
              {notification.state === "open" ? (
                <button
                  class="btn"
                  data-tip="Close this notification. The same card and source notify again only when their state changes again."
                  onClick={() => void post(`/api/notifications/${notification.id}/dismiss`, {}, "Dismissed.")}
                >
                  Dismiss
                </button>
              ) : null}
              {notification.card !== null ? (
                <button
                  class="btn"
                  aria-haspopup="menu"
                  data-tip={`Hide the ${notification.source} notifications of ${card} for a while.`}
                  onClick={(event) =>
                    setMuting({ notification, anchor: event.currentTarget.getBoundingClientRect() })
                  }
                >
                  Mute ▾
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
      {list && list.mutes.length > 0 ? (
        <>
          <h3>Muted</h3>
          {list.mutes.map((mute) => (
            <div key={`${mute.card}/${mute.source}`} class="row">
              <span>
                {mute.source} of {cardName(mute.card)}
                {mute.until ? ` until ${new Date(mute.until).toLocaleString()}` : " until you unmute"}
              </span>
              <button
                class="btn"
                onClick={() =>
                  void post(
                    "/api/notifications/unmute",
                    { card: mute.card, source: mute.source },
                    `Unmuted ${mute.source} of ${cardName(mute.card)}.`,
                  )
                }
              >
                Unmute
              </button>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
