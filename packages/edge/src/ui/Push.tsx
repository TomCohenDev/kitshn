import { useEffect, useState } from "preact/hooks";
import type { NotificationLevel } from "../core/notifications.ts";
import { DEFAULT_LEVELS, type PushDevice } from "../core/push.ts";
import { Check, WhyOff } from "./controls.tsx";
import { callApi } from "./store.ts";
import { whenText } from "./time.ts";

interface PushState {
  readonly publicKey: string;
  readonly devices: ReadonlyArray<PushDevice & { readonly mine: boolean }>;
  readonly testAt: number;
}

const LEVELS: ReadonlyArray<NotificationLevel> = ["info", "warn", "error"];
const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const toBase64Url = (buffer: ArrayBuffer | null) =>
  buffer === null
    ? ""
    : btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");

/** "22:00" as minutes after midnight, or null for a text that is no time of day. */
const minutesOf = (text: string) => {
  const [hours = "", minutes = ""] = text.trim().split(":");
  const h = Number(hours);
  const m = Number(minutes);
  return hours !== "" &&
    minutes.length === 2 &&
    Number.isInteger(h) &&
    Number.isInteger(m) &&
    h >= 0 &&
    h < 24 &&
    m >= 0 &&
    m < 60
    ? h * 60 + m
    : null;
};
const timeOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A name for this browser that the owner can change. */
const defaultLabel = () => {
  const agent = navigator.userAgent;
  const system =
    ["Android", "iPhone", "iPad", "Mac", "Windows", "Linux"].find((each) => agent.includes(each)) ??
    "Browser";
  return `${system} ${agent.includes("Firefox") ? "Firefox" : agent.includes("Safari") && !agent.includes("Chrome") ? "Safari" : "Chrome"}`;
};

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** K-1907: push on this device, and the list of every subscribed device with Remove and its last push. */
export function PushSection(props: { onToast: (text: string, error: boolean) => void }) {
  const [state, setState] = useState<PushState | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [label, setLabel] = useState(defaultLabel);
  const [levels, setLevels] = useState<ReadonlyArray<NotificationLevel>>(DEFAULT_LEVELS);
  const [quietFrom, setQuietFrom] = useState("");
  const [quietTo, setQuietTo] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!supported) return;
    void currentSubscription().then(async (current) => {
      const result = await callApi<PushState>("POST", "/api/push/devices", {
        mine: current?.endpoint ?? null,
      });
      if ("error" in result) return props.onToast(result.error, true);
      setState(result);
      const device = result.devices.find((each) => each.mine);
      if (device) {
        setLabel(device.label);
        setLevels(device.levels);
        setQuietFrom(device.quiet ? timeOf(device.quiet.start) : "");
        setQuietTo(device.quiet ? timeOf(device.quiet.end) : "");
      }
      // K-1907: after "Rotate push key" the browser holds a subscription of the old key, or kitshn forgot it.
      const stale =
        current !== null &&
        (!device || toBase64Url(current.options.applicationServerKey) !== result.publicKey) &&
        Notification.permission === "granted";
      if (stale) {
        await current.unsubscribe();
        setSubscription(null);
        await turnOn(result.publicKey, device?.label ?? label);
      } else setSubscription(device ? current : null);
    });
  }, [version]);

  const send = async (subscribed: PushSubscription, name: string) => {
    const keys = subscribed.toJSON().keys ?? {};
    const from = minutesOf(quietFrom);
    const to = minutesOf(quietTo);
    if ((quietFrom !== "" || quietTo !== "") && (from === null || to === null))
      return props.onToast("Write quiet hours as two times of day, for example 22:00 and 07:00.", true);
    const result = await callApi<{ ok: true }>("POST", "/api/push/subscribe", {
      endpoint: subscribed.endpoint,
      p256dh: keys["p256dh"] ?? "",
      auth: keys["auth"] ?? "",
      label: name,
      levels,
      quiet:
        from === null || to === null
          ? null
          : { start: from, end: to, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    if ("error" in result) props.onToast(result.error, true);
    return !("error" in result);
  };

  const turnOn = async (publicKey: string, name: string) => {
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      return props.onToast(
        "The browser blocks notifications for kitshn; allow them in its site settings.",
        true,
      );
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const subscribed = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(publicKey),
    });
    if (await send(subscribed, name)) {
      setSubscription(subscribed);
      props.onToast("Push is on for this device.", false);
      setVersion((each) => each + 1);
    }
  };

  const turnOff = async () => {
    if (!subscription) return;
    const result = await callApi<{ ok: true }>("POST", "/api/push/unsubscribe", {
      endpoint: subscription.endpoint,
    });
    if ("error" in result) return props.onToast(result.error, true);
    await subscription.unsubscribe();
    setSubscription(null);
    props.onToast("Push is off for this device.", false);
    setVersion((each) => each + 1);
  };

  const post = async (path: string, body: object, done: string) => {
    const result = await callApi<object>("POST", path, body);
    if ("error" in result) props.onToast(result.error, true);
    else {
      props.onToast(done, false);
      setVersion((each) => each + 1);
    }
  };

  if (!supported)
    return (
      <p class="muted">
        This browser has no Web Push. On an iPhone, add the map to the Home Screen and open it from there.
      </p>
    );
  return (
    <section class="push">
      <h3>This device</h3>
      {subscription ? (
        <>
          <input
            class="field"
            type="text"
            aria-label="Name of this device"
            data-tip="The name of this device in the list below."
            value={label}
            onInput={(event) => setLabel(event.currentTarget.value)}
          />
          <div class="row">
            {LEVELS.map((level) => (
              <Check
                key={level}
                checked={levels.includes(level)}
                label={level}
                tip={`Get ${level} notifications on this device. Priority high always comes.`}
                onChange={(on) =>
                  setLevels(on ? [...levels, level] : levels.filter((each) => each !== level))
                }
              />
            ))}
          </div>
          <div class="row">
            <span
              class="label"
              data-tip="Only error and priority high come in this time, in the time zone of this device."
            >
              Quiet
            </span>
            <input
              type="text"
              class="field time"
              aria-label="Quiet from"
              placeholder="22:00"
              value={quietFrom}
              onInput={(event) => setQuietFrom(event.currentTarget.value)}
            />
            <span>to</span>
            <input
              type="text"
              class="field time"
              aria-label="Quiet until"
              placeholder="07:00"
              value={quietTo}
              onInput={(event) => setQuietTo(event.currentTarget.value)}
            />
          </div>
          <div class="row">
            <button
              class="btn primary"
              data-tip="Keep the name, levels and quiet hours of this device."
              onClick={() =>
                void send(subscription, label).then((ok) => {
                  if (ok) {
                    props.onToast("Saved.", false);
                    setVersion((each) => each + 1);
                  }
                })
              }
            >
              Save
            </button>
            <button
              class="btn"
              data-tip="Send a test push to each of your devices. One a minute."
              disabled={state !== null && Date.now() - state.testAt < 60_000}
              onClick={() => void post("/api/push/test", {}, "Test sent.")}
            >
              Send a test
            </button>
            <button
              class="btn"
              data-tip="This device gets no push from kitshn anymore."
              onClick={() => void turnOff()}
            >
              Turn off
            </button>
          </div>
          <WhyOff
            reason={
              state !== null && Date.now() - state.testAt < 60_000
                ? "Send a test waits: one test a minute."
                : null
            }
          />
        </>
      ) : (
        <button
          class="btn primary"
          disabled={state === null}
          data-tip="Ask the browser for notifications, and get a push when kitshn has something for you."
          onClick={() => state && void turnOn(state.publicKey, label)}
        >
          Turn on push
        </button>
      )}
      <h3>Devices with push</h3>
      {state && state.devices.length === 0 ? <p class="muted">No device gets push yet.</p> : null}
      {state?.devices.map((device) => (
        <div key={device.id} class="row">
          <strong>{device.label}</strong>
          {device.mine ? <span class="sticker ok">this device</span> : null}
          <span class="muted">
            {device.email} · {device.lastOkAt ? `last push ${whenText(device.lastOkAt)}` : "no push yet"}
          </span>
          <button
            class="btn"
            data-tip={`${device.label} gets no push from kitshn anymore.`}
            onClick={() => void post("/api/push/unsubscribe", { id: device.id }, `Removed ${device.label}.`)}
          >
            Remove
          </button>
        </div>
      ))}
      {state && state.devices.length > 0 ? (
        <button
          class="btn"
          data-tip="A new push key. Every device stops getting push until its Notifications view opens again."
          onClick={() =>
            void post(
              "/api/push/rotate",
              {},
              "New push key. Each device subscribes again when it opens this view.",
            )
          }
        >
          Rotate push key
        </button>
      ) : null}
    </section>
  );
}
