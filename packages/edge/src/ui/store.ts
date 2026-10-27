import { useEffect, useState } from "preact/hooks";
import type { Edit } from "../core/changes.ts";
import type { State } from "../core/model.ts";
import type { ServerMessage, Snapshot } from "../core/protocol.ts";

export type Connection = "connecting" | "live" | "offline" | "refused";

interface StoreState {
  readonly snapshot: Snapshot | null;
  readonly connection: Connection;
  readonly reason: string | null;
}

type Result =
  { readonly ok: true; readonly revision: number | null } | { readonly ok: false; readonly error: string };

let current: StoreState = { snapshot: null, connection: "connecting", reason: null };
const listeners = new Set<() => void>();
const waiting = new Map<string, (result: Result) => void>();
let socket: WebSocket | null = null;
let retryDelay = 1000;

const set = (next: Partial<StoreState>) => {
  current = { ...current, ...next };
  for (const listener of listeners) listener();
};

export function useStore(): StoreState {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return current;
}

/** K-604 style backoff: 1 s, doubled after each failure, at most 30 s. */
export function connect() {
  const url = new URL("/api/ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  socket = ws;
  set({ connection: "connecting" });
  ws.onopen = () => {
    retryDelay = 1000;
    set({ connection: "live", reason: null });
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    if (message.type === "snapshot") set({ snapshot: message.snapshot });
    else {
      waiting.get(message.requestId)?.(message.ok ? { ok: true, revision: message.revision } : message);
      waiting.delete(message.requestId);
    }
  };
  ws.onclose = (event) => {
    for (const resolve of waiting.values()) resolve({ ok: false, error: "The connection closed." });
    waiting.clear();
    if (event.code === 4003 || event.code === 1008) {
      set({ connection: "refused", reason: event.reason || "kitshn refused the connection." });
      return;
    }
    set({ connection: "offline" });
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
}

/** Reports why the map cannot open, from the HTTP API, when the WebSocket closes at once. */
export async function explainRefusal() {
  const response = await fetch("/api/state");
  if (response.ok) return null;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `kitshn answered ${response.status}.`;
}

function request(message: object): Promise<Result> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: "kitshn is not connected. Wait for the live sticker." });
  }
  const requestId = crypto.randomUUID();
  socket.send(JSON.stringify({ ...message, requestId }));
  return new Promise((resolve) => waiting.set(requestId, resolve));
}

export const applyEdits = (edits: ReadonlyArray<Edit>) => request({ type: "apply", edits });
export const undoRevision = (revision: number) => request({ type: "undo", revision });

export function toState(snapshot: Snapshot): State {
  return {
    circles: new Map(snapshot.circles.map((circle) => [circle.id, circle])),
    resources: new Map(snapshot.resources.map((resource) => [resource.id, resource])),
    places: new Map(Object.entries(snapshot.places)),
    shareSettings: new Map(Object.entries(snapshot.shareSettings)),
  };
}
