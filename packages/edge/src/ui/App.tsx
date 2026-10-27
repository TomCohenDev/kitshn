import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Actor, Edit, ShareDiff } from "../core/changes.ts";
import {
  type Circle,
  type Level,
  RESOURCE_KINDS,
  type Resource,
  type ResourceKind,
  type State,
  circlesHolding,
  isPublicCircle,
  memberLabel,
  shareKey,
  shareLevel,
} from "../core/model.ts";
import { placeInside } from "../core/place.ts";
import type { JobView, MachineView, RevisionView } from "../core/protocol.ts";
import { CIRCLE_COLORS, KINDS, LEVEL_COLORS, MEMBER_ICONS } from "./kinds.ts";
import { CircleEditor, type DeviceSecret, EndsPicker, LevelOverride, SecretDialog } from "./Circle.tsx";
import { LibraryView } from "./Library.tsx";
import { AddMachine, MachinePanel, MachinesView } from "./Machines.tsx";
import { MapView, type Selection, type View } from "./Map.tsx";
import { overlay } from "./held.ts";
import {
  applyEdits,
  callApi,
  explainRefusal,
  hold,
  release,
  upload,
  toState,
  undoRevision,
  useStore,
} from "./store.ts";

const VIEW_KEY = "kitshn.view";
/**
 * On a wide screen the fit and a saved view stay at least this close, so card names stay readable on a
 * laptop. A bigger map is then centred, not shown whole; the wheel still zooms out to 0.15.
 */
const FIT_MIN_SCALE = 0.85;
const wideScreen = () => innerWidth > 720;
const UNDO_MS = 10_000;

interface Toast {
  readonly text: string;
  readonly error: boolean;
  readonly undo: number | null;
}

const loadView = (): View => {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as View | null;
    if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite))
      return wideScreen() ? { ...saved, s: Math.max(saved.s, FIT_MIN_SCALE) } : saved;
  } catch {
    // A broken saved view falls back to the default.
  }
  return { x: innerWidth / 2 - 200, y: innerHeight / 2, s: 1 };
};

const actorLabel = (actor: Actor) =>
  actor._tag === "person"
    ? actor.email
    : actor._tag === "device"
      ? `📱 ${actor.name}`
      : `kitshn (${actor.reason})`;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The tray shows the newest cards; the Library lists all of them (K-1005). */
const TRAY_CARDS = 8;

const routeFromHash = () => {
  const [tab = "map", id = ""] = location.hash.slice(1).split("/");
  return { tab: tab === "history" || tab === "machines" || tab === "library" ? tab : ("map" as const), id };
};

export function App() {
  const store = useStore();
  const [selection, setSelection] = useState<Selection>({ cards: new Set(), circle: null });
  const [hidden, setHidden] = useState<ReadonlySet<ResourceKind>>(new Set());
  const [view, setView] = useState<View>(loadView);
  const [openStacks, setOpenStacks] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [palette, setPalette] = useState(false);
  const [addingMachine, setAddingMachine] = useState(false);
  const [secret, setSecret] = useState<DeviceSecret | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; resolve: (ok: boolean) => void } | null>(null);
  const [route, setRoute] = useState(routeFromHash);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [fitted, setFitted] = useState(() => localStorage.getItem(VIEW_KEY) !== null);
  const toastTimer = useRef<number | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

  // The map shows held edits on top of the server state, so a drop never jumps back (see held.ts).
  const state = useMemo(
    () => (store.snapshot ? overlay(toState(store.snapshot), store.held) : null),
    [store.snapshot, store.held],
  );
  const machines = useMemo(
    () => new Map((store.snapshot?.machines ?? []).map((view) => [view.machine.id, view])),
    [store.snapshot],
  );

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      } else if (event.key === "Escape") {
        setPalette(false);
        setSelection({ cards: new Set(), circle: null });
      }
    };
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (store.connection === "refused" || (store.connection === "offline" && !store.snapshot)) {
      void explainRefusal().then(setRefusal);
    }
  }, [store.connection, store.snapshot]);

  const changeView = (next: View) => {
    setView(next);
    localStorage.setItem(VIEW_KEY, JSON.stringify(next));
  };

  const showToast = (next: Toast) => {
    setToast(next);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), UNDO_MS);
  };

  // A new question cancels an open one, so the edit that waits on it is released.
  const ask = (text: string) =>
    new Promise<boolean>((resolve) => {
      confirm?.resolve(false);
      setConfirm({ text, resolve });
    });

  /** Sends edits. K-210: a card that enters a public circle asks first. K-503: a share change shows Undo. */
  const commit = async (edits: Array<Edit>, diffs: Array<ShareDiff>) => {
    const goingPublic = diffs.filter((diff) => diff.to && !diff.from && isPublicCircle(diff.circle));
    // The drop stays where the owner let go while they answer; Cancel puts it back.
    const requestId = hold(edits);
    for (const diff of goingPublic) {
      if (!(await ask(`This makes ${diff.resource.name} public. Anyone with the address can open it.`))) {
        release(requestId);
        return;
      }
    }
    const result = await applyEdits(edits, requestId);
    if (!result.ok) showToast({ text: result.error, error: true, undo: null });
    else if (diffs.length > 0) {
      const text = diffs
        .slice(0, 2)
        .map((diff) =>
          diff.to
            ? `Shared ${diff.resource.name} with ${diff.circle.name} · ${diff.to}`
            : `Removed ${diff.resource.name} from ${diff.circle.name}`,
        )
        .join(". ");
      showToast({
        text: diffs.length > 2 ? `${text}. And ${diffs.length - 2} more.` : text,
        error: false,
        undo: result.revision,
      });
    }
  };

  const undo = async (revision: number) => {
    const result = await undoRevision(revision);
    showToast(
      result.ok
        ? { text: `Undid #${revision}.`, error: false, undo: null }
        : { text: result.error, error: true, undo: null },
    );
  };

  if (!state || !store.snapshot) {
    return (
      <div class="center">
        <div class="card">
          <h2>kitshn</h2>
          <p class="muted">
            {refusal ??
              store.reason ??
              (store.connection === "offline"
                ? "kitshn is not reachable. Trying again."
                : "Opening the map.")}
          </p>
        </div>
      </div>
    );
  }

  if (!fitted) {
    setFitted(true);
    queueMicrotask(() => fitRef.current?.());
  }
  const tray = [...state.resources.values()].filter((resource) => !state.places.has(resource.id));

  const fit = () => {
    const points = [
      ...[...state.circles.values()].flatMap((circle) => [
        { x: circle.x - circle.r, y: circle.y - circle.r },
        { x: circle.x + circle.r, y: circle.y + circle.r },
      ]),
      ...state.places.values(),
    ];
    if (points.length === 0) return;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const wide = wideScreen();
    const top = (document.querySelector("header.bar")?.getBoundingClientRect().bottom ?? 70) + 30;
    const left = tray.length > 0 ? (wide ? 230 : 170) : 10;
    const width = Math.max(innerWidth - left - (wide ? 410 : 10), 200);
    const height = Math.max(innerHeight - top - (wide ? 20 : innerHeight / 2), 200);
    const s = Math.min(
      2,
      Math.max(
        wide ? FIT_MIN_SCALE : 0.15,
        Math.min(width / (maxX - minX + 120), height / (maxY - minY + 160)),
      ),
    );
    changeView({
      s,
      x: left + (width - (maxX - minX) * s) / 2 - minX * s,
      y: top + (height - (maxY - minY) * s) / 2 - minY * s,
    });
  };

  fitRef.current = fit;

  const newCircle = async () => {
    const id = `c-${crypto.randomUUID().slice(0, 8)}`;
    const center = { x: (innerWidth / 2 - view.x) / view.s, y: (innerHeight / 2 - view.y) / view.s };
    const circle: Circle = {
      id,
      name: "New circle",
      color: CIRCLE_COLORS[state.circles.size % CIRCLE_COLORS.length] ?? "#6C5CE7",
      level: "view",
      members: [],
      match: "any",
      needsPasskey: false,
      endsAt: null,
      x: Math.round(center.x),
      y: Math.round(center.y),
      r: 220,
    };
    const result = await applyEdits([{ _tag: "circle", id, after: circle }]);
    if (result.ok) setSelection({ cards: new Set(), circle: id });
    else showToast({ text: result.error, error: true, undo: null });
  };

  /** K-511: share or unshare without a drag, by placing the card where exactly the wanted circles hold it. */
  const reshare = async (resource: Resource, circle: Circle, share: boolean) => {
    const current = new Set(circlesHolding(state, resource.id).map((held) => held.id));
    if (share) current.add(circle.id);
    else current.delete(circle.id);
    const from = state.places.get(resource.id) ?? { x: circle.x, y: circle.y };
    const to = placeInside(state, from, current);
    if (!to) {
      showToast({
        text: `No spot on the map is inside exactly those circles. Move "${circle.name}" so it overlaps the others, or drag the card.`,
        error: true,
        undo: null,
      });
      return;
    }
    const after: State = { ...state, places: new Map(state.places).set(resource.id, to) };
    const level = shareLevel(after, resource, circle);
    await commit(
      [{ _tag: "place", id: resource.id, after: to }],
      [{ resource, circle, from: share ? null : level, to: share ? level : null }],
    );
  };

  return (
    <>
      {route.tab === "map" ? (
        <MapView
          state={state}
          access={store.snapshot.access}
          selection={selection}
          onSelect={setSelection}
          hidden={hidden}
          view={view}
          onView={changeView}
          openStacks={openStacks}
          onToggleStack={(key) => {
            const next = new Set(openStacks);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            setOpenStacks(next);
          }}
          onCommit={(edits, diffs) => void commit(edits, diffs)}
          machines={machines}
        />
      ) : route.tab === "library" ? (
        <LibraryView
          state={state}
          revision={store.snapshot.revision}
          onToast={(text, error) => showToast({ text, error, undo: null })}
          ask={ask}
          onShowCard={(id) => {
            setSelection({ cards: new Set([id]), circle: null });
            location.hash = "map";
          }}
        />
      ) : route.tab === "machines" ? (
        <MachinesView machines={store.snapshot.machines} onAdd={() => setAddingMachine(true)} />
      ) : (
        <History revisions={store.snapshot.revisions} onUndo={(id) => void undo(id)} />
      )}
      {addingMachine ? <AddMachine onClose={() => setAddingMachine(false)} /> : null}
      {secret ? <SecretDialog secret={secret} onClose={() => setSecret(null)} /> : null}
      <header class="bar">
        <h1>kitshn</h1>
        <div class="seg">
          <button aria-pressed={route.tab === "map"} onClick={() => (location.hash = "map")}>
            Map
          </button>
          <button aria-pressed={route.tab === "machines"} onClick={() => (location.hash = "machines")}>
            Machines
          </button>
          <button aria-pressed={route.tab === "library"} onClick={() => (location.hash = "library")}>
            Library
          </button>
          <button aria-pressed={route.tab === "history"} onClick={() => (location.hash = "history")}>
            History
          </button>
        </div>
        {route.tab === "map" ? (
          <>
            <span class="sep" />
            {(Object.keys(RESOURCE_KINDS) as Array<ResourceKind>)
              .filter((kind) => [...state.resources.values()].some((resource) => resource.kind === kind))
              .map((kind) => (
                <button
                  key={kind}
                  class="btn toggle"
                  aria-pressed={!hidden.has(kind)}
                  title={`Show or hide ${KINDS[kind].label}`}
                  onClick={() => {
                    const next = new Set(hidden);
                    if (next.has(kind)) next.delete(kind);
                    else next.add(kind);
                    setHidden(next);
                  }}
                >
                  {KINDS[kind].icon} {KINDS[kind].label}
                </button>
              ))}
            <span class="sep" />
            <button class="btn primary" onClick={() => void newCircle()}>
              + Circle
            </button>
            <button class="btn" onClick={() => setAddingMachine(true)}>
              + Machine
            </button>
            <label
              class="btn"
              title="An HTML file becomes a page; any other file stays a file (at most 100 MB)"
            >
              Upload
              <input
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  void upload(file).then((result) =>
                    showToast(
                      "error" in result
                        ? { text: result.error, error: true, undo: null }
                        : {
                            text: `Uploaded ${file.name}. It waits in the tray, private.`,
                            error: false,
                            undo: null,
                          },
                    ),
                  );
                }}
              />
            </label>
            <button class="btn" onClick={fit}>
              Fit
            </button>
          </>
        ) : null}
        <span class="grow" />
        <button class="btn" onClick={() => setPalette(true)} title="Command palette (Cmd+K or Ctrl+K)">
          ⌘K
        </button>
        <span class={`sticker ${store.connection === "live" ? "ok" : "wait"}`} style={{ "--tilt": "3deg" }}>
          {store.connection}
        </span>
      </header>
      {tray.length > 0 && route.tab === "map" ? (
        <aside class="tray">
          <span class="label title">New · private</span>
          {tray.slice(-TRAY_CARDS).map((resource) => (
            <div
              key={resource.id}
              class={`card${selection.cards.has(resource.id) ? " sel" : ""}`}
              onClick={() => setSelection({ cards: new Set([resource.id]), circle: null })}
            >
              <div class="name">
                {KINDS[resource.kind].icon} {resource.name}
              </div>
              <div class="sub">{resource.addresses[0] ?? resource.kind}</div>
            </div>
          ))}
          {tray.length > TRAY_CARDS ? (
            <a class="muted" href="#library">
              {tray.length - TRAY_CARDS} more in the Library
            </a>
          ) : null}
        </aside>
      ) : null}
      <Panel
        state={state}
        selection={selection}
        access={store.snapshot.access}
        me={store.snapshot.me}
        accessTeam={store.snapshot.accessTeam}
        onSelectCard={(id) => setSelection({ cards: new Set([id]), circle: null })}
        onSelectCircle={(id) => setSelection({ cards: new Set(), circle: id })}
        onSecret={setSecret}
        onEdit={async (edits) => {
          const result = await applyEdits(edits);
          if (result.ok) return null;
          showToast({ text: result.error, error: true, undo: null });
          return result.error;
        }}
        onDeleteCircle={async (circle) => {
          if (
            !(await ask(
              `Delete the circle "${circle.name}"? Its cards stay where they are and lose its share.`,
            ))
          )
            return;
          const result = await applyEdits([{ _tag: "circle", id: circle.id, after: null }]);
          if (result.ok) {
            setSelection({ cards: new Set(), circle: null });
            showToast({ text: `Deleted circle ${circle.name}.`, error: false, undo: result.revision });
          } else showToast({ text: result.error, error: true, undo: null });
        }}
        onPlace={(resource) => {
          const center = { x: (innerWidth / 2 - view.x) / view.s, y: (innerHeight / 2 - view.y) / view.s };
          const to = placeInside(state, center, new Set());
          if (to) void commit([{ _tag: "place", id: resource.id, after: to }], []);
        }}
        onReshare={(resource, circle, share) => void reshare(resource, circle, share)}
        paused={store.snapshot.paused}
        machines={machines}
        version={store.snapshot.version}
        jobs={store.snapshot.jobs}
        onToast={(text, error) => showToast({ text, error, undo: null })}
        onRemoveMachine={async (view) => {
          if (
            !(await ask(
              `Remove ${view.machine.name}? kitshn deletes its service token, its tunnel and its queue (K-615).`,
            ))
          )
            return;
          const result = await callApi<{ removed: string }>(
            "DELETE",
            `/api/machines/${encodeURIComponent(view.machine.id)}`,
          );
          showToast(
            "error" in result
              ? { text: result.error, error: true, undo: null }
              : { text: `Removed ${view.machine.name}.`, error: false, undo: null },
          );
        }}
        warnings={store.snapshot.accessWarnings}
        onPause={async (pause) => {
          const text = pause
            ? "Pause sets every share to none, except the Owner circle's share of the admin. Pause now?"
            : "Resume gives every share back. Resume now?";
          if (!(await ask(text))) return;
          const result = await applyEdits([{ _tag: "pause", after: pause }]);
          showToast(
            result.ok
              ? {
                  text: pause ? "Paused. Only the Owner circle opens the admin." : "Resumed.",
                  error: false,
                  undo: result.revision,
                }
              : { text: result.error, error: true, undo: null },
          );
        }}
        onSignOut={async () => {
          if (!(await ask("End every session of every kitshn application? Everyone logs in again, you too.")))
            return;
          const result = await callApi<{ ended: number; failed: Array<string> }>("POST", "/api/sign-out", {});
          showToast(
            "error" in result
              ? { text: result.error, error: true, undo: null }
              : {
                  text:
                    `Ended the sessions of ${plural(result.ended, "application")}.` +
                    (result.failed.length > 0 ? ` Failed: ${result.failed.join("; ")}` : ""),
                  error: result.failed.length > 0,
                  undo: null,
                },
          );
        }}
      />
      {store.snapshot.paused ? (
        <div class="banner" role="status">
          Paused: only the Owner circle opens the admin. Everything else is closed.
        </div>
      ) : null}
      {palette ? (
        <Palette
          state={state}
          onClose={() => setPalette(false)}
          actions={{
            select: (selected) => {
              setSelection(selected);
              location.hash = "map";
            },
            reshare: (resource, circle, share) => void reshare(resource, circle, share),
            newCircle: () => void newCircle(),
            fit,
            history: () => (location.hash = "history"),
          }}
        />
      ) : null}
      {confirm ? (
        <div class="scrim">
          <div class="dialog" role="alertdialog">
            <p style={{ marginTop: 0, fontWeight: 700 }}>{confirm.text}</p>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button class="btn" onClick={() => (confirm.resolve(false), setConfirm(null))}>
                Cancel
              </button>
              <button class="btn primary" autoFocus onClick={() => (confirm.resolve(true), setConfirm(null))}>
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div class={`toast${toast.error ? " error" : ""}`} role="status">
          <span>{toast.text}</span>
          {toast.undo !== null ? (
            <button
              class="btn primary"
              onClick={() => {
                const revision = toast.undo;
                setToast(null);
                if (revision !== null) void undo(revision);
              }}
            >
              Undo
            </button>
          ) : null}
          <button class="btn" onClick={() => setToast(null)} aria-label="Close">
            ×
          </button>
        </div>
      ) : null}
      {route.tab === "map" ? (
        <div class="hint">
          Drag a card into a circle to share it · Shift-click or drag empty space to select many · Alt-drag a
          circle head to move it alone · Ctrl or ⌘ + wheel zooms
        </div>
      ) : null}
    </>
  );
}

function History(props: { revisions: ReadonlyArray<RevisionView>; onUndo: (id: number) => void }) {
  return (
    <section class="history">
      <h2>History</h2>
      <p class="muted">Every change is one revision. Undo makes a new revision that reverses it.</p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.revisions.map((revision) => (
            <tr key={revision.id} id={`rev-${revision.id}`}>
              <td class="id">{revision.id}</td>
              <td>{new Date(revision.at).toLocaleString()}</td>
              <td>{actorLabel(revision.actor)}</td>
              <td>{revision.summary}</td>
              <td>
                {revision.undoneBy !== null ? (
                  <span class="stamp" title={`Undone by #${revision.undoneBy}`}>
                    ✓ undone
                  </span>
                ) : revision.undoes === null && revision.undoable ? (
                  <button class="btn" onClick={() => props.onUndo(revision.id)}>
                    Undo
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Panel(props: {
  state: State;
  selection: Selection;
  access: Readonly<Record<string, import("../core/protocol.ts").AccessState>>;
  me: Actor;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onDeleteCircle: (circle: Circle) => void;
  onPlace: (resource: Resource) => void;
  onReshare: (resource: Resource, circle: Circle, share: boolean) => void;
  paused: boolean;
  warnings: ReadonlyArray<string>;
  machines: ReadonlyMap<string, MachineView>;
  jobs: ReadonlyArray<JobView>;
  onRemoveMachine: (view: MachineView) => void;
  version: string;
  onToast: (text: string, error: boolean) => void;
  onPause: (pause: boolean) => void;
  onSignOut: () => void;
  accessTeam: string;
  onSelectCard: (id: string) => void;
  onSelectCircle: (id: string) => void;
  onSecret: (secret: DeviceSecret) => void;
}) {
  const { state, selection } = props;
  const [sheetOpen, setSheetOpen] = useState(true);
  const circle = selection.circle ? state.circles.get(selection.circle) : undefined;
  const cards = [...selection.cards].flatMap((id) => {
    const resource = state.resources.get(id);
    return resource ? [resource] : [];
  });
  let body;
  if (circle)
    body = (
      <CircleEditor
        key={circle.id}
        circle={circle}
        state={state}
        accessTeam={props.accessTeam}
        onEdit={props.onEdit}
        onDelete={props.onDeleteCircle}
        onSelectCard={props.onSelectCard}
        onSecret={props.onSecret}
      />
    );
  else if (cards.length === 1 && cards[0]) {
    body = (
      <CardPanel
        resource={cards[0]}
        state={state}
        access={props.access[cards[0].id] ?? null}
        onEdit={props.onEdit}
        onPlace={props.onPlace}
        onReshare={props.onReshare}
        machine={props.machines.get(cards[0].id) ?? null}
        version={props.version}
        jobs={props.jobs}
        onRemoveMachine={props.onRemoveMachine}
        onToast={props.onToast}
      />
    );
  } else if (cards.length > 1) {
    body = (
      <section>
        <div class="label">Selection</div>
        <h2>{cards.length} cards</h2>
        <p>Drag them together into or out of a circle.</p>
        <ul>
          {cards.map((resource) => (
            <li key={resource.id}>
              {KINDS[resource.kind].icon} {resource.name}
            </li>
          ))}
        </ul>
      </section>
    );
  } else {
    body = (
      <section>
        <div class="label">kitshn</div>
        <h2>The map</h2>
        <p>
          Circles say <b>who</b>: people, email domains, devices, networks. A card inside a circle is shared
          with that circle at its level.
        </p>
        <p>
          A card counts for every circle it sits in. Select a card to see who can open it, or a circle head to
          edit it.
        </p>
        <div class="label">Circles</div>
        <ul class="opens">
          {[...state.circles.values()].map((item) => (
            <li key={item.id}>
              <button type="button" class="open-card" onClick={() => props.onSelectCircle(item.id)}>
                <span class="name">
                  <span class="swatch" style={{ background: item.color }} /> {item.name}
                </span>
                <span class="muted">
                  {plural(
                    [...state.places.keys()].filter((id) =>
                      circlesHolding(state, id).some((held) => held.id === item.id),
                    ).length,
                    "card",
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p class="muted">You are {actorLabel(props.me)}.</p>
        {props.warnings.length > 0 ? (
          <>
            <div class="label">Access warnings</div>
            <ul>
              {props.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </>
        ) : null}
        <div class="label">Safety</div>
        <div class="row">
          <button class="btn danger" onClick={() => props.onPause(!props.paused)}>
            {props.paused ? "Resume" : "Emergency pause"}
          </button>
          <button class="btn" onClick={props.onSignOut}>
            Sign out everywhere
          </button>
        </div>
      </section>
    );
  }
  return (
    <aside class={`side${sheetOpen ? "" : " closed"}`}>
      <div class="handle" onClick={() => setSheetOpen(!sheetOpen)} />
      {body}
    </aside>
  );
}

function CardPanel(props: {
  resource: Resource;
  state: State;
  access: import("../core/protocol.ts").AccessState | null;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onPlace: (resource: Resource) => void;
  onReshare: (resource: Resource, circle: Circle, share: boolean) => void;
  machine: MachineView | null;
  jobs: ReadonlyArray<JobView>;
  onRemoveMachine: (view: MachineView) => void;
  version: string;
  onToast: (text: string, error: boolean) => void;
}) {
  const { resource, state } = props;
  const holding = circlesHolding(state, resource.id);
  const address = resource.addresses[0];
  return (
    <section>
      <div class="label">{KINDS[resource.kind].label}</div>
      <h2>
        {KINDS[resource.kind].icon} {resource.name}
      </h2>
      {address ? (
        <div class="row">
          <code>{address}</code>
          <button class="btn" onClick={() => void navigator.clipboard.writeText(`https://${address}`)}>
            Copy address
          </button>
          <a class="btn" href={`https://${address}`} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      ) : null}
      {props.access ? (
        <div class="row">
          <span class="label">Access</span>
          {props.access.state === "applied" ? (
            <span class="stamp" title="Cloudflare has this change">
              ✓ applied
            </span>
          ) : (
            <span class={`sticker ${props.access.state === "applying" ? "wait" : ""}`}>
              {props.access.state}
            </span>
          )}
          {props.access.state === "failed" ? <span class="muted">{props.access.error}</span> : null}
        </div>
      ) : null}
      {!state.places.has(resource.id) ? (
        <button class="btn primary" onClick={() => props.onPlace(resource)}>
          Place on the map
        </button>
      ) : null}
      {props.machine ? (
        <MachinePanel
          view={props.machine}
          version={props.version}
          jobs={props.jobs}
          onRemove={() => props.machine && props.onRemoveMachine(props.machine)}
          onToast={props.onToast}
        />
      ) : null}
      <div class="label" style={{ marginTop: "12px" }}>
        Who can open it
      </div>
      {holding.length === 0 ? (
        <p>
          No circle holds it, so <b>no one</b> can open it.
        </p>
      ) : (
        <ul>
          {holding.map((circle) => {
            const setting = state.shareSettings.get(shareKey(resource.id, circle.id));
            const level = shareLevel(state, resource, circle);
            const put = (next: { level: Level | null; endsAt: number | null }) =>
              props.onEdit([
                {
                  _tag: "shareSetting",
                  resourceId: resource.id,
                  circleId: circle.id,
                  after: next.level === null && next.endsAt === null ? null : next,
                },
              ]);
            return (
              <li key={circle.id}>
                <div class="row">
                  <span class="swatch" style={{ background: circle.color }} /> <b>{circle.name}</b>
                  <span class="sticker" style={{ background: level ? LEVEL_COLORS[level] : undefined }}>
                    {level ?? "none"}
                  </span>
                  <button
                    class="btn"
                    title="Unshare without a drag"
                    onClick={() => props.onReshare(resource, circle, false)}
                  >
                    Remove
                  </button>
                </div>
                <div class="row">
                  {circle.members.map((member, index) => (
                    <span class="chip" key={index}>
                      {MEMBER_ICONS[member._tag]} {memberLabel(member)}
                    </span>
                  ))}
                </div>
                <div class="field-row">
                  <span class="label">Level</span>
                  <LevelOverride resource={resource} circle={circle} state={state} onEdit={props.onEdit} />
                </div>
                <div class="field-row">
                  <span class="label">Ends</span>
                  <EndsPicker
                    endsAt={setting?.endsAt ?? null}
                    onChange={(endsAt) => void put({ level: setting?.level ?? null, endsAt })}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {state.places.has(resource.id) ? (
        <>
          <div class="label">Share with</div>
          <div class="row">
            {[...state.circles.values()]
              .filter((circle) => !holding.includes(circle))
              .map((circle) => (
                <button key={circle.id} class="btn" onClick={() => props.onReshare(resource, circle, true)}>
                  <span class="swatch" style={{ background: circle.color }} /> {circle.name}
                </button>
              ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

interface PaletteActions {
  select: (selection: Selection) => void;
  reshare: (resource: Resource, circle: Circle, share: boolean) => void;
  newCircle: () => void;
  fit: () => void;
  history: () => void;
}

function Palette(props: { state: State; onClose: () => void; actions: PaletteActions }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { state, actions } = props;
  const entries = useMemo(() => {
    const all: Array<{ label: string; run: () => void }> = [
      { label: "New circle", run: actions.newCircle },
      { label: "Fit the map", run: actions.fit },
      { label: "Open History", run: actions.history },
    ];
    for (const resource of state.resources.values()) {
      all.push({
        label: `${KINDS[resource.kind].icon} ${resource.name}`,
        run: () => actions.select({ cards: new Set([resource.id]), circle: null }),
      });
      if (!state.places.has(resource.id)) continue;
      const holding = new Set(circlesHolding(state, resource.id).map((circle) => circle.id));
      for (const circle of state.circles.values()) {
        all.push(
          holding.has(circle.id)
            ? {
                label: `Unshare ${resource.name} from ${circle.name}`,
                run: () => actions.reshare(resource, circle, false),
              }
            : {
                label: `Share ${resource.name} with ${circle.name}`,
                run: () => actions.reshare(resource, circle, true),
              },
        );
      }
    }
    for (const circle of state.circles.values()) {
      all.push({
        label: `⭕ ${circle.name}`,
        run: () => actions.select({ cards: new Set(), circle: circle.id }),
      });
    }
    return all;
  }, [state, actions]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = entries
    .filter((entry) => words.every((word) => entry.label.toLowerCase().includes(word)))
    .slice(0, 50);
  const run = (index: number) => {
    const entry = matches[index];
    if (!entry) return;
    props.onClose();
    entry.run();
  };
  return (
    <div class="scrim" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div class="dialog" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          placeholder="Find a card, a circle or an action. Try “share”."
          value={query}
          onInput={(event) => {
            setQuery((event.target as HTMLInputElement).value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") setActive(Math.min(active + 1, matches.length - 1));
            else if (event.key === "ArrowUp") setActive(Math.max(active - 1, 0));
            else if (event.key === "Enter") run(active);
            else return;
            event.preventDefault();
          }}
        />
        <ul>
          {matches.map((entry, index) => (
            <li
              key={entry.label}
              aria-selected={index === active}
              onClick={() => run(index)}
              onMouseEnter={() => setActive(index)}
            >
              {entry.label}
            </li>
          ))}
          {matches.length === 0 ? <li>Nothing matches.</li> : null}
        </ul>
      </div>
    </div>
  );
}
