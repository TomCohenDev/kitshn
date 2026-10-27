import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Actor, Edit, ShareDiff } from "../core/changes.ts";
import {
  type Circle,
  LEVELS,
  type Level,
  type Member,
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
import { CIRCLE_COLORS, KINDS, MEMBER_ICONS } from "./kinds.ts";
import { AddMachine, MachinePanel, MachinesView } from "./Machines.tsx";
import { MapView, type Selection, type View } from "./Map.tsx";
import { overlay } from "./held.ts";
import { applyEdits, callApi, explainRefusal, toState, undoRevision, useStore } from "./store.ts";

const VIEW_KEY = "kitshn.view";
const UNDO_MS = 10_000;

interface Toast {
  readonly text: string;
  readonly error: boolean;
  readonly undo: number | null;
}

const loadView = (): View => {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as View | null;
    if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite)) return saved;
  } catch {
    // A broken saved view falls back to the default.
  }
  return { x: innerWidth / 2 - 200, y: innerHeight / 2, s: 0.7 };
};

const actorLabel = (actor: Actor) =>
  actor._tag === "person"
    ? actor.email
    : actor._tag === "device"
      ? `📱 ${actor.name}`
      : `kitshn (${actor.reason})`;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const routeFromHash = () => {
  const [tab = "map", id = ""] = location.hash.slice(1).split("/");
  return { tab: tab === "history" || tab === "machines" ? tab : ("map" as const), id };
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

  const ask = (text: string) => new Promise<boolean>((resolve) => setConfirm({ text, resolve }));

  /** Sends edits. K-210: a card that enters a public circle asks first. K-503: a share change shows Undo. */
  const commit = async (edits: Array<Edit>, diffs: Array<ShareDiff>) => {
    const goingPublic = diffs.filter((diff) => diff.to && !diff.from && isPublicCircle(diff.circle));
    for (const diff of goingPublic) {
      if (!(await ask(`This makes ${diff.resource.name} public. Anyone with the address can open it.`)))
        return;
    }
    const result = await applyEdits(edits);
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
    const wide = innerWidth > 720;
    const left = tray.length > 0 ? (wide ? 210 : 170) : 10;
    const width = Math.max(innerWidth - left - (wide ? 370 : 10), 200);
    const height = Math.max(innerHeight - (wide ? 100 : innerHeight / 2), 200);
    const s = Math.min(
      2,
      Math.max(0.15, Math.min(width / (maxX - minX + 120), height / (maxY - minY + 160))),
    );
    changeView({
      s,
      x: left + (width - (maxX - minX) * s) / 2 - minX * s,
      y: 80 + (height - (maxY - minY) * s) / 2 - minY * s,
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
      ) : route.tab === "machines" ? (
        <MachinesView machines={store.snapshot.machines} onAdd={() => setAddingMachine(true)} />
      ) : (
        <History revisions={store.snapshot.revisions} onUndo={(id) => void undo(id)} />
      )}
      {addingMachine ? <AddMachine onClose={() => setAddingMachine(false)} /> : null}
      <header class="bar">
        <h1>kitshn</h1>
        <div class="seg">
          <button aria-pressed={route.tab === "map"} onClick={() => (location.hash = "map")}>
            Map
          </button>
          <button aria-pressed={route.tab === "machines"} onClick={() => (location.hash = "machines")}>
            Machines
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
          {tray.map((resource) => (
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
        </aside>
      ) : null}
      <Panel
        state={state}
        selection={selection}
        access={store.snapshot.access}
        me={store.snapshot.me}
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

const toLocalInput = (time: number | null) =>
  time === null ? "" : new Date(time - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fromLocalInput = (value: string) => (value ? new Date(value).getTime() : null);

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
        onEdit={props.onEdit}
        onDelete={props.onDeleteCircle}
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
        <ul>
          {[...state.circles.values()].map((item) => (
            <li key={item.id}>
              <b style={{ color: item.color }}>●</b> {item.name}:{" "}
              {plural(
                [...state.places.keys()].filter((id) =>
                  circlesHolding(state, id).some((held) => held.id === item.id),
                ).length,
                "card",
              )}
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
  const kindLevels: ReadonlyArray<Level> = RESOURCE_KINDS[resource.kind];
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
          <span
            class={`sticker ${props.access.state === "applied" ? "ok" : props.access.state === "applying" ? "wait" : ""}`}
          >
            {props.access.state}
          </span>
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
                  <b style={{ color: circle.color }}>●</b> <b>{circle.name}</b>
                  <span class="sticker" style={{ background: circle.color }}>
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
                <div class="row">
                  <span class="label">Level</span>
                  <select
                    value={setting?.level ?? ""}
                    onChange={(event) => {
                      const value = (event.target as HTMLSelectElement).value;
                      put({ level: value === "" ? null : (value as Level), endsAt: setting?.endsAt ?? null });
                    }}
                  >
                    <option value="">circle default ({circle.level})</option>
                    {kindLevels.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="row">
                  <span class="label">Ends</span>
                  <input
                    type="datetime-local"
                    value={toLocalInput(setting?.endsAt ?? null)}
                    onChange={(event) =>
                      put({
                        level: setting?.level ?? null,
                        endsAt: fromLocalInput((event.target as HTMLInputElement).value),
                      })
                    }
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
                  <b style={{ color: circle.color }}>●</b> {circle.name}
                </button>
              ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

type DeviceMember = Extract<Member, { _tag: "device" }>;

/** K-106: pick an Access service token as a device member, or make a new one. */
function DevicePicker(props: { onAdd: (member: DeviceMember) => Promise<string | null> }) {
  const [devices, setDevices] = useState<Array<Omit<DeviceMember, "_tag">> | null>(null);
  const [picked, setPicked] = useState("");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (devices === null) {
    return (
      <div class="row">
        <button
          class="btn"
          onClick={async () => {
            const result = await callApi<Array<Omit<DeviceMember, "_tag">>>("GET", "/api/devices");
            if ("error" in result) setError(result.error);
            else setDevices(result);
          }}
        >
          📱 Add a device…
        </button>
        {error ? <span class="muted">{error}</span> : null}
      </div>
    );
  }
  return (
    <div>
      <div class="row">
        <select value={picked} onChange={(event) => setPicked((event.target as HTMLSelectElement).value)}>
          <option value="">Pick a service token</option>
          {devices.map((device) => (
            <option key={device.tokenId} value={device.tokenId}>
              {device.name}
            </option>
          ))}
        </select>
        <button
          class="btn"
          disabled={!picked}
          onClick={() => {
            const device = devices.find((item) => item.tokenId === picked);
            if (device) void props.onAdd({ _tag: "device", ...device }).then(setError);
          }}
        >
          Add
        </button>
      </div>
      <form
        class="row"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await callApi<DeviceMember & { clientSecret: string }>("POST", "/api/devices", {
            name,
          });
          if ("error" in result) return setError(result.error);
          setError(null);
          setName("");
          setSecret({ clientId: result.clientId, clientSecret: result.clientSecret });
          setDevices([...devices, { tokenId: result.tokenId, clientId: result.clientId, name: result.name }]);
          const refused = await props.onAdd({
            _tag: "device",
            tokenId: result.tokenId,
            clientId: result.clientId,
            name: result.name,
          });
          if (refused) setError(`The token exists, but the circle did not take it: ${refused}`);
        }}
      >
        <input
          value={name}
          placeholder="New device, for example Her phone"
          onInput={(event) => setName((event.target as HTMLInputElement).value)}
        />
        <button class="btn">Make a token</button>
      </form>
      {secret ? (
        <div class="secret">
          <div class="label">Shown once. Put it on the device now.</div>
          <code>CF-Access-Client-Id: {secret.clientId}</code>
          <code>CF-Access-Client-Secret: {secret.clientSecret}</code>
        </div>
      ) : null}
      {error ? <p class="muted">{error}</p> : null}
    </div>
  );
}

const MEMBER_KINDS = ["email", "domain", "ip", "everyone"] as const;
type AddableKind = (typeof MEMBER_KINDS)[number];

function memberFrom(kind: AddableKind, value: string): Member | string {
  const text = value.trim();
  if (kind === "everyone") return { _tag: "everyone" };
  if (!text) return "Type a value first.";
  if (kind === "email")
    return text.includes("@") ? { _tag: "email", email: text.toLowerCase() } : "An email needs an @.";
  if (kind === "domain") return { _tag: "domain", domain: text.replace(/^@/, "").toLowerCase() };
  return text.includes("/")
    ? { _tag: "ip", range: text }
    : { _tag: "ip", range: text.includes(":") ? `${text}/128` : `${text}/32` };
}

function CircleEditor(props: {
  circle: Circle;
  state: State;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onDelete: (circle: Circle) => void;
}) {
  const { circle, state } = props;
  const [kind, setKind] = useState<AddableKind>("email");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const put = (next: Partial<Circle>) =>
    props.onEdit([{ _tag: "circle", id: circle.id, after: { ...circle, ...next } }]);
  const inside = [...state.resources.values()].filter((resource) =>
    circlesHolding(state, resource.id).includes(circle),
  );
  return (
    <section>
      <div class="label">Circle</div>
      <h2>{circle.name}</h2>
      <div class="row">
        <span class="label">Name</span>
        <input
          value={circle.name}
          onChange={(event) => put({ name: (event.target as HTMLInputElement).value.trim() || circle.name })}
        />
        <input
          type="color"
          value={circle.color}
          onChange={(event) => put({ color: (event.target as HTMLInputElement).value.toUpperCase() })}
        />
      </div>
      <div class="row">
        <span class="label">Level</span>
        <div class="seg">
          {LEVELS.map((level) => (
            <button key={level} aria-pressed={circle.level === level} onClick={() => put({ level })}>
              {level}
            </button>
          ))}
        </div>
      </div>
      <div class="row">
        <span class="label">Match</span>
        <div class="seg">
          <button
            aria-pressed={circle.match === "any"}
            onClick={() => put({ match: "any" })}
            title="The visitor matches at least one member"
          >
            any
          </button>
          <button
            aria-pressed={circle.match === "all"}
            onClick={() => put({ match: "all" })}
            title="The visitor matches every member"
          >
            all must match
          </button>
        </div>
      </div>
      <div class="row">
        <label>
          <input
            type="checkbox"
            checked={circle.needsPasskey}
            onChange={(event) => put({ needsPasskey: (event.target as HTMLInputElement).checked })}
          />{" "}
          Needs a passkey 🔑
        </label>
      </div>
      <div class="row">
        <span class="label">Ends</span>
        <input
          type="datetime-local"
          value={toLocalInput(circle.endsAt)}
          onChange={(event) => put({ endsAt: fromLocalInput((event.target as HTMLInputElement).value) })}
        />
      </div>
      <div class="label" style={{ marginTop: "10px" }}>
        Who is in it
      </div>
      <div class="row">
        {circle.members.length === 0 ? (
          <span class="muted">Nobody yet. A circle with no members matches nobody.</span>
        ) : null}
        {circle.members.map((member, index) => (
          <span class="chip" key={index}>
            {MEMBER_ICONS[member._tag]} {memberLabel(member)}
            <button
              title="Remove"
              onClick={() => put({ members: circle.members.filter((_, other) => other !== index) })}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        class="row"
        onSubmit={(event) => {
          event.preventDefault();
          const member = memberFrom(kind, value);
          if (typeof member === "string") return setError(member);
          setError(null);
          setValue("");
          put({ members: [...circle.members, member] });
        }}
      >
        <select
          value={kind}
          onChange={(event) => setKind((event.target as HTMLSelectElement).value as AddableKind)}
        >
          {MEMBER_KINDS.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
        {kind !== "everyone" ? (
          <input
            value={value}
            placeholder={
              kind === "email" ? "name@example.com" : kind === "domain" ? "example.com" : "10.0.0.0/24"
            }
            onInput={(event) => setValue((event.target as HTMLInputElement).value)}
            style={{ width: "150px" }}
          />
        ) : null}
        <button class="btn">Add</button>
      </form>
      {error ? <p class="muted">{error}</p> : null}
      <DevicePicker
        onAdd={(member) =>
          props.onEdit([
            { _tag: "circle", id: circle.id, after: { ...circle, members: [...circle.members, member] } },
          ])
        }
      />
      <div class="label" style={{ marginTop: "10px" }}>
        What it opens ({inside.length})
      </div>
      <ul>
        {inside.map((resource) => (
          <li key={resource.id}>
            {KINDS[resource.kind].icon} {resource.name} · {shareLevel(state, resource, circle) ?? "none"}
          </li>
        ))}
        {inside.length === 0 ? <li>Nothing yet. Drag cards in.</li> : null}
      </ul>
      <button class="btn danger" onClick={() => props.onDelete(circle)}>
        Delete circle
      </button>
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
