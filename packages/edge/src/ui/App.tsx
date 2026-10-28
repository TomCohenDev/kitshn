import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import {
  type Actor,
  type Edit,
  type ShareDiff,
  applyChanges,
  isAppCard,
  resolveEdits,
  shareDiff,
} from "../core/changes.ts";
import {
  type Circle,
  type Level,
  RESOURCE_KINDS,
  type Resource,
  type ResourceKind,
  type Stack,
  type State,
  type PauseMode,
  type Point,
  circlesHolding,
  insideCircle,
  isPublicCircle,
  memberLabel,
  shareKey,
  shareLevel,
} from "../core/model.ts";
import { MAX_UPLOAD_BYTES } from "../core/library.ts";
import { placeInside } from "../core/place.ts";
import type { Command } from "../core/machine.ts";
import type { JobView, MachineView, RepoView, RevisionView } from "../core/protocol.ts";
import { CIRCLE_COLORS, KINDS, LEVEL_COLORS, MEMBER_ICONS } from "./kinds.ts";
import {
  CircleEditor,
  type DeviceSecret,
  EndsPicker,
  LEVEL_TIPS,
  LevelOverride,
  MEMBER_HELP,
  SecretDialog,
} from "./Circle.tsx";
import { ActionMenu, TooltipLayer } from "./controls.tsx";
import {
  type ActionContext,
  type ActionHandlers,
  type MenuTarget,
  type PaletteEntry,
  actionsFor,
  REMOVE_APP_TIP,
  levelEdit,
  paletteEntries,
} from "./actions.ts";
import type { Rect } from "./popover.ts";
import { AddSite } from "./Add.tsx";
import { PauseDialog, PausedBanner } from "./Pause.tsx";
import { REPO_STICKERS, RepoList, setRepoState } from "./Repos.tsx";
import { LibraryView } from "./Library.tsx";
import { AddMachine, MachinePanel, MachinesView, queueJob } from "./Machines.tsx";
import { ACCESS_TIPS, ALONE_KEY, MapView, type Selection, TRAY_CARDS_TYPE, type View } from "./Map.tsx";
import { overlay } from "./held.ts";
import {
  type Connection,
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
const PREVIEWS_KEY = "kitshn.previews";
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
  /** More revisions that the same Undo takes back after `undo`, newest first (a drop of several files). */
  readonly alsoUndo?: ReadonlyArray<number>;
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

const CONNECTION_TIPS: Record<Connection, string> = {
  connecting: "Connecting: the map opens a connection to kitshn.",
  live: "Live: the map shows each change at once.",
  offline: "Offline: kitshn is not reachable. The map tries again.",
  refused: "Refused: kitshn did not take the connection. The panel says why.",
};

const TABS = {
  map: "Map: circles say who, and a card inside a circle is shared with it.",
  machines: "Machines: a table of every machine and its status.",
  library: "Library: every page and file, with a search, a preview and Delete.",
  history: "History: every change as one revision, with Undo.",
} as const;

/** K-1504 */
const PAUSE_TIP =
  "Emergency pause: close every share except the Owner circle's admin, and stop agent keys and new deploys. Public sites, apps and pages stay up unless you choose a lockdown.";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

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
  /** The palette's first query, or null while it is closed. */
  const [palette, setPalette] = useState<string | null>(null);
  const [addingMachine, setAddingMachine] = useState(false);
  const [secret, setSecret] = useState<DeviceSecret | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [trayFilter, setTrayFilter] = useState("");
  const [previews, setPreviews] = useState(() => localStorage.getItem(PREVIEWS_KEY) === "on");
  const [addingSite, setAddingSite] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  /** Where the next upload of the file chooser lands: a map point, or null for the tray. */
  const uploadAt = useRef<Point | null>(null);
  const [menu, setMenu] = useState<{ readonly target: MenuTarget; readonly anchor: Rect } | null>(null);
  const [pausing, setPausing] = useState(false);
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
  const deployed = useMemo(() => new Set(store.snapshot?.deployedCards ?? []), [store.snapshot]);

  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash());
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => (open === null ? "" : null));
      } else if (event.key === "Escape") {
        setPalette(null);
        setSelection({ cards: new Set(), circle: null });
      }
    };
    // A file dropped outside the map would make the browser open it and leave kitshn.
    const keepFiles = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    // K-1504: Access sends the owner back here after the fresh passkey check of "Resume".
    if (location.hash === "#resume") void finishResume();
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    addEventListener("dragover", keepFiles);
    addEventListener("drop", keepFiles);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
      removeEventListener("dragover", keepFiles);
      removeEventListener("drop", keepFiles);
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

  /**
   * K-1101: uploads one file after the other. With `at` (a drop on the map), the cards land there and so get
   * the shares of the circles around that point; a public circle asks first (K-210). Without, they wait
   * in the tray, private.
   */
  const uploadFiles = async (files: Array<File>, at: Point | null) => {
    const tooBig = files.filter((file) => file.size > MAX_UPLOAD_BYTES);
    const fitting = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
    const refused =
      tooBig.length > 0
        ? `${tooBig.map((file) => file.name).join(", ")}: kitshn takes at most 100 MB a file.`
        : "";
    if (fitting.length === 0 || !state) {
      if (refused) showToast({ text: refused, error: true, undo: null });
      return;
    }
    // Every card lands in exactly the circles of the drop point, also when several fan out (K-204).
    const circles = [...state.circles.values()];
    const wanted = new Set(
      at ? circles.filter((circle) => insideCircle(at, circle)).map((circle) => circle.id) : [],
    );
    const publicHere = circles.filter((circle) => wanted.has(circle.id) && isPublicCircle(circle));
    if (publicHere.length > 0) {
      const what = fitting.length === 1 ? fitting[0]?.name : plural(fitting.length, "file");
      const where = publicHere.map((circle) => circle.name).join(", ");
      if (!(await ask(`This makes ${what} public in ${where}. Anyone with the address can open it.`))) return;
    }
    const added: Array<{ id: string; revision: number }> = [];
    const errors: Array<string> = [];
    for (const [index, file] of fitting.entries()) {
      const spot = at ? { x: at.x + (index % 2) * 30, y: at.y + index * 90 } : null;
      const point = spot && at ? (placeInside(state, spot, wanted) ?? at) : null;
      const step = `${index + 1} of ${fitting.length}: ${file.name}`;
      setProgress(`Uploading ${step}`);
      const result = await upload(file, point, (fraction) =>
        setProgress(`Uploading ${step} · ${Math.round(fraction * 100)}%`),
      );
      if ("error" in result) errors.push(result.error);
      else added.push(result);
    }
    setProgress(null);
    if (added.length > 0) setSelection({ cards: new Set(added.map((item) => item.id)), circle: null });
    const done =
      added.length === 0
        ? ""
        : at
          ? `Added ${plural(added.length, "card")} where you dropped them.`
          : `Uploaded ${plural(added.length, "file")}. They wait in the tray, private.`;
    // K-503: a drop changes shares, so one Undo takes back the whole drop, newest first.
    const [last, ...earlier] = at ? added.map((item) => item.revision).reverse() : [];
    showToast({
      text: [done, ...errors, refused].filter(Boolean).join(" "),
      error: errors.length > 0 || refused !== "",
      undo: last ?? null,
      alsoUndo: earlier,
    });
  };

  /** K-521, K-522: stack actions; each is one revision through `commit`, so a public circle asks first. */
  const stacks: StackActions = {
    stackOnto: async (ids, target) => {
      if (!state) return;
      const place = state.places.get(target);
      if (!place) {
        showToast({ text: "Put one of the cards on the map first.", error: true, undo: null });
        return;
      }
      const into = [...state.stacks.values()].find((stack) => stack.members.includes(target));
      const moving = ids.filter((id) => id !== target && !into?.members.includes(id));
      if (moving.length === 0) return;
      const edits: Array<Edit> = moving.map((id) => ({ _tag: "place", id, after: place }));
      // A card leaves its old stack; a stack left with one card goes.
      for (const stack of state.stacks.values()) {
        if (stack === into || !stack.members.some((id) => moving.includes(id))) continue;
        const rest = stack.members.filter((id) => !moving.includes(id));
        edits.push({
          _tag: "stack",
          id: stack.id,
          after: rest.length > 1 ? { ...stack, members: rest } : null,
        });
      }
      const id = into?.id ?? `s-${crypto.randomUUID().slice(0, 8)}`;
      edits.push({
        _tag: "stack",
        id,
        after: { id, name: into?.name ?? state.resources.get(target)?.name ?? "Stack", members: [...(into?.members ?? [target]), ...moving] },
      });
      const names = moving.flatMap((card) => state.resources.get(card)?.name ?? []).join(", ");
      await commit(
        edits,
        shareDiff(state, applyChanges(state, resolveEdits(state, edits))),
        `Stacked ${names} with ${into?.name ?? state.resources.get(target)?.name ?? "the card"}.`,
      );
    },
    pullOut: async (stackId, id) => {
      const stack = state?.stacks.get(stackId);
      const place = state?.places.get(id);
      if (!state || !stack || !place) return;
      const rest = stack.members.filter((member) => member !== id);
      const wanted = new Set(circlesHolding(state, id).map((circle) => circle.id));
      // Next to the stack, in the same circles, so pulling a card out changes no share.
      const after = placeInside(state, { x: place.x + 230, y: place.y }, wanted) ?? place;
      const edits: Array<Edit> = [
        { _tag: "stack", id: stackId, after: rest.length > 1 ? { ...stack, members: rest } : null },
        { _tag: "place", id, after },
      ];
      await commit(
        edits,
        shareDiff(state, applyChanges(state, resolveEdits(state, edits))),
        `Pulled ${state.resources.get(id)?.name ?? "the card"} out of ${stack.name}.`,
      );
    },
    unstack: async (stackId) => {
      const stack = state?.stacks.get(stackId);
      if (!state || !stack) return;
      const first = state.places.get(stack.members[0] ?? "");
      if (!first) return;
      const wanted = new Set(circlesHolding(state, stack.members[0] ?? "").map((circle) => circle.id));
      const edits: Array<Edit> = [
        { _tag: "stack", id: stackId, after: null },
        ...stack.members.slice(1).map((id, index): Edit => ({
          _tag: "place",
          id,
          after: placeInside(state, { x: first.x, y: first.y + (index + 1) * 100 }, wanted) ?? first,
        })),
      ];
      await commit(
        edits,
        shareDiff(state, applyChanges(state, resolveEdits(state, edits))),
        `Unstacked ${stack.name}.`,
      );
    },
    rename: async (stackId, name) => {
      const stack = state?.stacks.get(stackId);
      if (!stack || !name.trim() || name.trim() === stack.name) return;
      await commit(
        [{ _tag: "stack", id: stackId, after: { ...stack, name: name.trim().slice(0, 80) } }],
        [],
        `Renamed the stack to ${name.trim().slice(0, 80)}.`,
      );
    },
  };

  /**
   * K-509: cards dragged from the tray land at the drop point, each in exactly the circles there, so they
   * get those shares; a public circle asks first, as for any drag (K-210).
   */
  const placeFromTray = async (ids: Array<string>, at: Point) => {
    if (!state) return;
    const wanted = new Set(
      [...state.circles.values()].filter((circle) => insideCircle(at, circle)).map((c) => c.id),
    );
    const edits: Array<Extract<Edit, { _tag: "place" }>> = ids
      .filter((id) => state.resources.has(id) && !state.places.has(id))
      .map((id, index) => ({
        _tag: "place",
        id,
        after: placeInside(state, { x: at.x + (index % 2) * 30, y: at.y + index * 90 }, wanted) ?? at,
      }));
    if (edits.length === 0) return;
    await commit(edits, shareDiff(state, applyChanges(state, resolveEdits(state, edits))));
    setSelection({ cards: new Set(edits.map((edit) => edit.id)), circle: null });
  };

  /** Selects an item and puts the focus into an input of its panel, after the panel renders. */
  const selectAndFocus = (next: Selection, selector: string) => {
    setSelection(next);
    location.hash = "map";
    queueMicrotask(() => setTimeout(() => document.querySelector<HTMLInputElement>(selector)?.focus()));
  };

  /** Opens the circle editor with its Add member input ready. */
  const addMemberTo = (circleId: string) =>
    selectAndFocus({ cards: new Set(), circle: circleId }, ".add-member input");

  /** K-1504: one press after the confirm pauses everything at once. */
  const pauseNow = async (mode: PauseMode) => {
    setPausing(false);
    const result = await applyEdits([{ _tag: "pause", after: mode }]);
    showToast(
      result.ok
        ? {
            text:
              mode === "lockdown"
                ? "Locked down. Only the Owner circle's people open the admin; public sites are closed too."
                : "Paused. Only the Owner circle's people open the admin; public sites stay open.",
            error: false,
            undo: null,
          }
        : { text: result.error, error: true, undo: null },
    );
  };

  /** Resume needs a fresh passkey: Access checks it on `/api/fresh` and sends the owner back to `#resume`. */
  const startResume = () => location.assign("/api/fresh/start");

  const finishResume = async () => {
    history.replaceState(null, "", location.pathname + location.search);
    // MM-712: a link alone never resumes; the owner confirms once more after the passkey check.
    if (!(await ask("Your passkey check passed. Resume everything now? Every share comes back."))) return;
    const result = await callApi<{ revision: number | null }>("POST", "/api/fresh/resume", {});
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: "Resumed. Every share is back.", error: false, undo: null },
    );
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
  const commit = async (edits: Array<Edit>, diffs: Array<ShareDiff>, done?: string) => {
    const goingPublic = diffs.filter((diff) => diff.to && !diff.from && isPublicCircle(diff.circle));
    // The drop stays where the owner let go while they answer; Cancel puts it back.
    const requestId = hold(edits);
    if (goingPublic.length > 0) {
      const names = [...new Set(goingPublic.map((diff) => diff.resource.name))].join(", ");
      if (!(await ask(`This makes ${names} public. Anyone with the address can open it.`))) {
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
    } else if (done) showToast({ text: done, error: false, undo: result.revision });
  };

  const undo = async (revision: number) => {
    const result = await undoRevision(revision);
    showToast(
      result.ok
        ? { text: [`Undid #${revision}.`, ...result.notes].join(" "), error: false, undo: null }
        : { text: result.error, error: true, undo: null },
    );
  };

  /** K-909: no confirm; the toast and History undo it. */
  const removeApp = async (resource: Resource) => {
    const result = await callApi<{ revision: number | null; notes: ReadonlyArray<string> }>(
      "DELETE",
      `/api/apps/${encodeURIComponent(resource.id)}`,
    );
    if ("error" in result) {
      showToast({ text: result.error, error: true, undo: null });
      return;
    }
    setSelection({ cards: new Set(), circle: null });
    showToast({ text: [`Removed ${resource.name}.`, ...result.notes].join(" "), error: false, undo: result.revision });
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
  const shownTray = tray
    .filter((resource) =>
      `${resource.name} ${resource.kind} ${resource.addresses[0] ?? ""}`
        .toLowerCase()
        .includes(trayFilter.trim().toLowerCase()),
    )
    .reverse();

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

  /** A new circle at `at`, or in the middle of the view. */
  const newCircle = async (at: Point | null) => {
    const id = `c-${crypto.randomUUID().slice(0, 8)}`;
    const center = at ?? { x: (innerWidth / 2 - view.x) / view.s, y: (innerHeight / 2 - view.y) / view.s };
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
    // A stacked card takes its stack along (K-521), so the diff comes from the resolved changes.
    const edits: Array<Edit> = [{ _tag: "place", id: resource.id, after: to }];
    await commit(edits, shareDiff(state, applyChanges(state, resolveEdits(state, edits))));
  };

  /** No confirm: Undo in the toast and in History brings the circle back. */
  const deleteCircle = async (circle: Circle) => {
    const result = await applyEdits([{ _tag: "circle", id: circle.id, after: null }]);
    if (result.ok) {
      setSelection({ cards: new Set(), circle: null });
      showToast({ text: `Deleted circle ${circle.name}.`, error: false, undo: result.revision });
    } else showToast({ text: result.error, error: true, undo: null });
  };

  /** K-615: no confirm, and no undo; History records it. */
  const removeMachine = async (machine: MachineView) => {
    const result = await callApi<{ removed: string }>("DELETE", `/api/machines/${encodeURIComponent(machine.machine.id)}`);
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: `Removed ${machine.machine.name}: its token and tunnel are gone. History records it.`, error: false, undo: null },
    );
  };

  /**
   * K-110: no confirm; History records the start and the outcome. Sessions left show as a warning with
   * Retry, which calls the same endpoint family.
   */
  const signOut = async (retry: boolean) => {
    const result = await callApi<{ ended: number; failed: Array<string> }>(
      "POST",
      retry ? "/api/sign-out/retry" : "/api/sign-out",
      {},
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : {
            text:
              `Ended the sessions of ${plural(result.ended, "application")}. Everyone logs in again.` +
              (result.failed.length > 0 ? ` Failed: ${result.failed.join("; ")}` : ""),
            error: result.failed.length > 0,
            undo: null,
          },
    );
  };

  const runJob = (machine: MachineView, command: Command) =>
    queueJob(machine.machine.id, command).then(({ text, error }) => showToast({ text, error, undo: null }));

  const placeInView = (resource: Resource) => {
    const center = { x: (innerWidth / 2 - view.x) / view.s, y: (innerHeight / 2 - view.y) / view.s };
    const to = placeInside(state, center, new Set());
    if (to) void commit([{ _tag: "place", id: resource.id, after: to }], []);
  };

  const uploadTo = (at: Point | null) => {
    uploadAt.current = at;
    location.hash = "map";
    setTimeout(() => uploadInput.current?.click());
  };

  /** K-523: the menu and the palette run these, the same as the toolbar and the panel. */
  const handlers: ActionHandlers = {
    select: (selected) => {
      setSelection(selected);
      location.hash = "map";
    },
    openAddress: (address) => void open(`https://${address}`, "_blank", "noreferrer"),
    copyAddress: (address) => void navigator.clipboard.writeText(`https://${address}`),
    reshare: (resource, circle, share) => void reshare(resource, circle, share),
    setLevel: (resource, circle, level) =>
      void applyEdits([levelEdit(state, resource, circle, level)]).then(
        (result) => result.ok || showToast({ text: result.error, error: true, undo: null }),
      ),
    place: placeInView,
    toTray: (resource) => {
      const edits: Array<Edit> = [{ _tag: "place", id: resource.id, after: null }];
      void commit(
        edits,
        shareDiff(state, applyChanges(state, resolveEdits(state, edits))),
        `Moved ${resource.name} to the tray.`,
      );
    },
    stackOnto: (ids, target) => void stacks.stackOnto(ids, target),
    pullOut: (stackId, id) => void stacks.pullOut(stackId, id),
    unstack: (stackId) => void stacks.unstack(stackId),
    renameStack: (stackId) =>
      selectAndFocus(
        { cards: new Set(state.stacks.get(stackId)?.members ?? []), circle: null },
        'input[aria-label="Stack name"]',
      ),
    removeApp: (resource) => void removeApp(resource),
    runJob: (machine, command) => void runJob(machine, command),
    removeMachine: (machine) => void removeMachine(machine),
    editCircle: (circleId) => {
      setSelection({ cards: new Set(), circle: circleId });
      location.hash = "map";
    },
    renameCircle: (circleId) =>
      selectAndFocus({ cards: new Set(), circle: circleId }, 'input[aria-label="Circle name"]'),
    addMember: addMemberTo,
    deleteCircle: (circle) => void deleteCircle(circle),
    newCircle: (at) => void newCircle(at),
    upload: uploadTo,
    addSite: () => setAddingSite(true),
    addMachine: () => setAddingMachine(true),
    fit,
  };
  const actionContext: ActionContext = { state, deployed, machines, version: store.snapshot.version };

  const waitingRepos = store.snapshot?.repos.filter((repo) => repo.state === "waiting").length ?? 0;
  return (
    <>
      {route.tab === "map" ? (
        <MapView
          onDropFiles={(files, at) => void uploadFiles(files, at)}
          onDropCards={(ids, at) => void placeFromTray(ids, at)}
          onStackOnto={(ids, target) => void stacks.stackOnto(ids, target)}
          previews={previews}
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
          onMenu={setMenu}
        />
      ) : route.tab === "library" ? (
        <LibraryView
          state={state}
          revision={store.snapshot.revision}
          onToast={(text, error) => showToast({ text, error, undo: null })}
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
      {addingSite ? (
        <AddSite
          zone={store.snapshot.zone}
          machines={store.snapshot.machines}
          onClose={() => setAddingSite(false)}
          onDone={(text) => showToast({ text, error: false, undo: null })}
        />
      ) : null}
      {secret ? <SecretDialog secret={secret} onClose={() => setSecret(null)} /> : null}
      {progress ? (
        <div class="progress" role="status">
          <span class="sticker wait" data-tip="Upload: kitshn sends the files one after the other.">
            upload
          </span>{" "}
          {progress}
        </div>
      ) : null}
      <TooltipLayer />
      {/* Outside the map toolbar, so an upload from the palette on another tab finds it. */}
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          const at = uploadAt.current;
          uploadAt.current = null;
          void uploadFiles(files, at);
        }}
      />
      <header class="bar">
        <h1>kitshn</h1>
        <div class="seg">
          {(["map", "machines", "library", "history"] as const).map((tab) => (
            <button
              key={tab}
              aria-pressed={route.tab === tab}
              data-tip={TABS[tab]}
              onClick={() => (location.hash = tab)}
            >
              {tab[0]?.toUpperCase()}
              {tab.slice(1)}
            </button>
          ))}
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
                  data-tip={`${hidden.has(kind) ? "Show" : "Hide"} ${KINDS[kind].label.toLowerCase()} on the map. Hidden kinds still count for their circles.`}
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
            <button
              class="btn primary"
              data-tip="Make a new circle in the middle of the view. It matches nobody until you add members."
              onClick={() => void newCircle(null)}
            >
              + Circle
            </button>
            <button
              class="btn"
              data-tip="Make a join command for a new machine. Its card starts in the tray, private."
              onClick={() => setAddingMachine(true)}
            >
              + Machine
            </button>
            <button
              class="btn"
              data-tip="Add a person, a domain, a device or a network to a circle."
              onClick={() => setPalette("add a member to ")}
            >
              + Member
            </button>
            <button
              class="btn"
              data-tip="Share a local server of a machine, or set up a static site from a repo."
              onClick={() => setAddingSite(true)}
            >
              + Site
            </button>
            <button
              class="btn"
              data-tip="Upload files: an HTML file becomes a page, any other file stays a file (at most 100 MB). They wait in the tray, private. You can also drop files on the map."
              onClick={() => uploadTo(null)}
            >
              Upload
            </button>
            <button class="btn" data-tip="Fit every circle and card in the view." onClick={fit}>
              Fit
            </button>
            <button
              class="btn toggle"
              aria-pressed={previews}
              data-tip={`${previews ? "Hide" : "Show"} live previews of up to four site and page cards near the centre, from zoom 80%.`}
              onClick={() => {
                localStorage.setItem(PREVIEWS_KEY, previews ? "off" : "on");
                setPreviews(!previews);
              }}
            >
              Previews{previews && view.s < 0.8 ? " (zoom in)" : ""}
            </button>
          </>
        ) : null}
        <span class="grow" />
        {waitingRepos > 0 ? (
          <button
            class="btn"
            data-tip="Repos that wait for you to allow their first deploy. A click shows them in the panel."
            onClick={() => {
              location.hash = "map";
              setSelection({ cards: new Set(), circle: null });
            }}
          >
            <span class="sticker wait">{plural(waitingRepos, "repo")} waiting</span>
          </button>
        ) : null}
        {store.snapshot?.paused ? (
          <button
            class="btn resume"
            onClick={startResume}
            data-tip="Resume: confirm with your passkey again, and every share comes back."
          >
            Resume
          </button>
        ) : (
          <button
            class="btn big-red"
            onClick={() => setPausing(true)}
            data-tip={PAUSE_TIP}
            aria-label="Emergency pause"
          >
            ■ Pause
          </button>
        )}
        <button
          class="btn"
          onClick={() => setPalette("")}
          aria-label="Command palette"
          data-tip="Command palette (Cmd+K or Ctrl+K): find every card, circle and action."
        >
          ⌘K
        </button>
        <span
          class={`sticker ${store.connection === "live" ? "ok" : "wait"}`}
          style={{ "--tilt": "3deg" }}
          data-tip={CONNECTION_TIPS[store.connection]}
        >
          {store.connection}
        </span>
      </header>
      {tray.length > 0 && route.tab === "map" ? (
        <aside class="tray">
          <div class="tray-head">
            <span
              class="label"
              data-tip="New cards arrive here, outside every circle, so they start private."
            >
              New · private ({tray.length})
            </span>
            <input
              type="search"
              placeholder="Filter"
              aria-label="Filter the tray"
              data-tip="Filter the tray by name, kind or address."
              value={trayFilter}
              onInput={(event) => setTrayFilter((event.target as HTMLInputElement).value)}
            />
            <span class="help">Drag cards onto the map. Shift-click picks several.</span>
          </div>
          <div class="tray-list">
            {shownTray.length === 0 ? <p class="help">No card matches.</p> : null}
            {shownTray.map((resource) => (
              <div
                key={resource.id}
                class={`card${selection.cards.has(resource.id) ? " sel" : ""}`}
                data-tip={`${KINDS[resource.kind].help} Drag it onto the map; it lands in exactly the circles there.`}
                draggable
                onDragStart={(event) => {
                  // A selected card carries the whole selection of tray cards with it.
                  const ids = selection.cards.has(resource.id)
                    ? shownTray.filter((item) => selection.cards.has(item.id)).map((item) => item.id)
                    : [resource.id];
                  event.dataTransfer?.setData(TRAY_CARDS_TYPE, JSON.stringify(ids));
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                }}
                onClick={(event) => {
                  const cards = new Set(event.shiftKey ? selection.cards : []);
                  if (event.shiftKey && cards.has(resource.id)) cards.delete(resource.id);
                  else cards.add(resource.id);
                  setSelection({ cards, circle: null });
                }}
              >
                <div class="name">
                  {KINDS[resource.kind].icon} {resource.name}
                </div>
                <div class="sub">{resource.addresses[0] ?? resource.kind}</div>
              </div>
            ))}
          </div>
        </aside>
      ) : null}
      <Panel
        state={state}
        repos={store.snapshot.repos}
        selection={selection}
        access={store.snapshot.access}
        me={store.snapshot.me}
        accessTeam={store.snapshot.accessTeam}
        onSelectCard={(id) => setSelection({ cards: new Set([id]), circle: null })}
        onSelectCircle={(id) => setSelection({ cards: new Set(), circle: id })}
        stacks={stacks}
        onSecret={setSecret}
        onEdit={async (edits) => {
          const result = await applyEdits(edits);
          if (result.ok) return null;
          showToast({ text: result.error, error: true, undo: null });
          return result.error;
        }}
        onDeleteCircle={handlers.deleteCircle}
        onPlace={placeInView}
        onReshare={(resource, circle, share) => void reshare(resource, circle, share)}
        onRemoveApp={(resource) => void removeApp(resource)}
        deployed={deployed}
        paused={store.snapshot.paused !== null}
        machines={machines}
        version={store.snapshot.version}
        jobs={store.snapshot.jobs}
        onToast={(text, error) => showToast({ text, error, undo: null })}
        onRemoveMachine={handlers.removeMachine}
        onRunJob={runJob}
        warnings={store.snapshot.accessWarnings}
        onPause={(pause) => (pause ? setPausing(true) : startResume())}
        onSignOut={(retry) => void signOut(retry)}
        signOutWarning={store.snapshot.signOutWarning}
      />
      {store.snapshot.paused ? (
        <PausedBanner
          mode={store.snapshot.paused}
          by={store.snapshot.pausedBy ? actorLabel(store.snapshot.pausedBy.actor) : null}
          since={store.snapshot.pausedBy ? `since ${new Date(store.snapshot.pausedBy.at).toLocaleString()}` : null}
          onLockdown={() => void pauseNow("lockdown")}
          onResume={startResume}
        />
      ) : null}
      {pausing ? <PauseDialog onCancel={() => setPausing(false)} onPause={(mode) => void pauseNow(mode)} /> : null}
      {palette !== null ? (
        <Palette
          initialQuery={palette}
          onClose={() => setPalette(null)}
          entries={[
            { label: "Open History", tip: TABS.history, run: () => (location.hash = "history") },
            {
              label: "Emergency pause, or Resume",
              tip: PAUSE_TIP,
              run: () => (store.snapshot?.paused ? startResume() : setPausing(true)),
            },
            ...(store.snapshot.signOutWarning
              ? [
                  {
                    label: "Retry sign-out everywhere",
                    tip: store.snapshot.signOutWarning,
                    run: () => void signOut(true),
                  },
                ]
              : []),
            ...paletteEntries(actionContext, handlers),
          ]}
        />
      ) : null}
      {menu && route.tab === "map" ? <ContextMenu menu={menu} context={actionContext} handlers={handlers} onClose={() => setMenu(null)} /> : null}
      {confirm ? (
        <div class="scrim">
          <div class="dialog" role="alertdialog">
            <p style={{ marginTop: 0, fontWeight: 700 }}>{confirm.text}</p>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                class="btn"
                data-tip="Cancel: nothing changes."
                onClick={() => (confirm.resolve(false), setConfirm(null))}
              >
                Cancel
              </button>
              <button
                class="btn primary"
                autoFocus
                data-tip="Continue with the change."
                onClick={() => (confirm.resolve(true), setConfirm(null))}
              >
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
              data-tip="Undo: take this change back."
              onClick={() => {
                const revisions = [...(toast.undo === null ? [] : [toast.undo]), ...(toast.alsoUndo ?? [])];
                setToast(null);
                void (async () => {
                  for (const revision of revisions) await undo(revision);
                })();
              }}
            >
              Undo
            </button>
          ) : null}
          <button class="btn" onClick={() => setToast(null)} aria-label="Close" data-tip="Close this message.">
            ×
          </button>
        </div>
      ) : null}
      {route.tab === "map" ? (
        <div class="hint">
          Drag a card into a circle to share it · Right-click, a long press or ⋯ shows its actions · Shift-click or drag empty space to select many · {ALONE_KEY.label}-drag a
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
                  <span class="stamp" data-tip={`Undone: revision #${revision.undoneBy} reverses this one.`}>
                    ✓ undone
                  </span>
                ) : revision.undoes === null && revision.undoable ? (
                  <button
                    class="btn"
                    data-tip="Undo: a new revision that reverses this one."
                    onClick={() => props.onUndo(revision.id)}
                  >
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
  /** K-819: the repos that deploy or wait to deploy. */
  repos: ReadonlyArray<RepoView>;
  selection: Selection;
  access: Readonly<Record<string, import("../core/protocol.ts").AccessState>>;
  me: Actor;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onDeleteCircle: (circle: Circle) => void;
  onPlace: (resource: Resource) => void;
  onReshare: (resource: Resource, circle: Circle, share: boolean) => void;
  onRemoveApp: (resource: Resource) => void;
  /** K-909 */
  deployed: ReadonlySet<string>;
  paused: boolean;
  warnings: ReadonlyArray<string>;
  machines: ReadonlyMap<string, MachineView>;
  jobs: ReadonlyArray<JobView>;
  onRemoveMachine: (view: MachineView) => void;
  onRunJob: (view: MachineView, command: Command) => Promise<void>;
  version: string;
  onToast: (text: string, error: boolean) => void;
  onPause: (pause: boolean) => void;
  onSignOut: (retry: boolean) => void;
  signOutWarning: string | null;
  accessTeam: string;
  onSelectCard: (id: string) => void;
  onSelectCircle: (id: string) => void;
  stacks: StackActions;
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
        repo={props.repos.find((repo) => repo.resourceIds.includes(cards[0]?.id ?? "")) ?? null}
        access={props.access[cards[0].id] ?? null}
        onEdit={props.onEdit}
        onPlace={props.onPlace}
        onReshare={props.onReshare}
        onRemoveApp={props.onRemoveApp}
        deployed={props.deployed.has(cards[0].id)}
        machine={props.machines.get(cards[0].id) ?? null}
        version={props.version}
        jobs={props.jobs}
        onRemoveMachine={props.onRemoveMachine}
        onRunJob={props.onRunJob}
        onToast={props.onToast}
      />
    );
  } else if (cards.length > 1) {
    const ids = new Set(cards.map((card) => card.id));
    const stackOfAll = [...state.stacks.values()].find(
      (stack) => stack.members.length === ids.size && stack.members.every((id) => ids.has(id)),
    );
    body = (
      <section>
        <div class="label" data-tip="Selection: the cards that you picked. They move as one.">
          Selection
        </div>
        <h2>{cards.length} cards</h2>
        <p>Drag them together into or out of a circle, or stack them to keep them together.</p>
        <ul>
          {cards.map((resource) => (
            <li key={resource.id}>
              {KINDS[resource.kind].icon} {resource.name}
            </li>
          ))}
        </ul>
        <button
          class="btn primary"
          data-tip="Stack these cards: they sit on one point, move as one and get the same circles."
          onClick={() =>
            void props.stacks.stackOnto(
              cards.map((card) => card.id),
              cards.find((card) => state.places.has(card.id))?.id ?? cards[0]?.id ?? "",
            )
          }
        >
          Stack these
        </button>
      </section>
    );
    if (stackOfAll) body = (
      <StackPanel stack={stackOfAll} state={state} actions={props.stacks} onSelectCard={props.onSelectCard} />
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
        <div class="label" data-tip="Circles: every circle on the map. A click edits one.">
          Circles
        </div>
        <ul class="opens">
          {[...state.circles.values()].map((item) => (
            <li key={item.id}>
              <button
                type="button"
                class="open-card"
                data-tip={`Edit ${item.name}: its members, level, match and end.`}
                onClick={() => props.onSelectCircle(item.id)}
              >
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
        <RepoList repos={props.repos} onToast={props.onToast} />
        <p class="muted">You are {actorLabel(props.me)}.</p>
        {props.warnings.length > 0 || props.signOutWarning ? (
          <>
            <div class="label" data-tip="Access warnings: Access applications that kitshn did not make and that cover a kitshn address.">
              Access warnings
            </div>
            <ul>
              {props.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {props.signOutWarning ? (
                <li>
                  {props.signOutWarning}{" "}
                  <button
                    type="button"
                    class="btn"
                    data-tip="Retry sign-out: revoke the sessions of the applications above again. The warning goes once every session ended."
                    onClick={() => props.onSignOut(true)}
                  >
                    Retry sign-out
                  </button>
                </li>
              ) : null}
            </ul>
          </>
        ) : null}
        <div class="label" data-tip="Safety: stop everything at once, or end every session.">
          Safety
        </div>
        <div class="row">
          <button
            class="btn danger"
            data-tip={
              props.paused
                ? "Resume: confirm with your passkey again, and every share comes back."
                : PAUSE_TIP
            }
            onClick={() => props.onPause(!props.paused)}
          >
            {props.paused ? "Resume" : "Emergency pause"}
          </button>
          <button
            class="btn danger"
            data-tip="Sign out everywhere: ends every Access session of kitshn's apps at once. Everyone logs in again, you too. History records it."
            onClick={() => props.onSignOut(false)}
          >
            Sign out everywhere: ends every session
          </button>
        </div>
      </section>
    );
  }
  return (
    <aside class={`side${sheetOpen ? "" : " closed"}`}>
      <button
        type="button"
        class="handle"
        aria-label={sheetOpen ? "Close the panel" : "Open the panel"}
        data-tip={sheetOpen ? "Close the panel." : "Open the panel."}
        onClick={() => setSheetOpen(!sheetOpen)}
      />
      {body}
    </aside>
  );
}

interface StackActions {
  stackOnto: (ids: Array<string>, target: string) => Promise<void>;
  pullOut: (stackId: string, id: string) => Promise<void>;
  unstack: (stackId: string) => Promise<void>;
  rename: (stackId: string, name: string) => Promise<void>;
}

/** K-521: one stack of the owner: its name, its cards with "Pull out", and "Unstack". */
function StackPanel(props: {
  stack: Stack;
  state: State;
  actions: StackActions;
  onSelectCard: (id: string) => void;
}) {
  const { stack, state } = props;
  const holding = circlesHolding(state, stack.members[0] ?? "");
  return (
    <section class="editor">
      <div class="label">Stack</div>
      <input
        class="title"
        aria-label="Stack name"
        data-tip="The name of the stack. Enter saves it."
        key={stack.name}
        defaultValue={stack.name}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        onBlur={(event) => void props.actions.rename(stack.id, (event.target as HTMLInputElement).value)}
      />
      <p class="help">
        Its {stack.members.length} cards move as one and share every circle:{" "}
        {holding.length > 0 ? holding.map((circle) => circle.name).join(", ") : "none, so they are private"}.
      </p>
      <h3 class="label">Cards</h3>
      <ul class="opens">
        {stack.members.map((id) => {
          const resource = state.resources.get(id);
          return (
            <li key={id}>
              <div class="open-card">
                {/* One card's own level and end date (K-205, K-209) are in its panel. */}
                <button
                  type="button"
                  class="name link"
                  data-tip="Show this card's panel, with its own level and end date."
                  onClick={() => props.onSelectCard(id)}
                >
                  {resource ? `${KINDS[resource.kind].icon} ${resource.name}` : id}
                </button>
                <button
                  type="button"
                  class="btn"
                  data-tip="Pull out: the card lands next to the stack, in the same circles, so no share changes."
                  onClick={() => void props.actions.pullOut(stack.id, id)}
                >
                  Pull out
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        class="btn"
        data-tip="Unstack: spread all cards in the same circles."
        onClick={() => void props.actions.unstack(stack.id)}
      >
        Unstack
      </button>
    </section>
  );
}

function CardPanel(props: {
  resource: Resource;
  state: State;
  /** K-819: the repo gate of the repo that deploys this card, when it has one. */
  repo: RepoView | null;
  access: import("../core/protocol.ts").AccessState | null;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onPlace: (resource: Resource) => void;
  onReshare: (resource: Resource, circle: Circle, share: boolean) => void;
  onRemoveApp: (resource: Resource) => void;
  /** K-909: a deploy made this card, so "Remove app" applies. */
  deployed: boolean;
  machine: MachineView | null;
  jobs: ReadonlyArray<JobView>;
  onRemoveMachine: (view: MachineView) => void;
  onRunJob: (view: MachineView, command: Command) => Promise<void>;
  version: string;
  onToast: (text: string, error: boolean) => void;
}) {
  const { resource, state } = props;
  const holding = circlesHolding(state, resource.id);
  const address = resource.addresses[0];
  return (
    <section>
      <div class="label" data-tip={KINDS[resource.kind].help}>
        {KINDS[resource.kind].label}
      </div>
      <h2>
        {KINDS[resource.kind].icon} {resource.name}
      </h2>
      {address ? (
        <div class="row">
          <code>{address}</code>
          <button
            class="btn"
            data-tip={`Copy https://${address} to the clipboard.`}
            onClick={() => void navigator.clipboard.writeText(`https://${address}`)}
          >
            Copy address
          </button>
          <a
            class="btn"
            href={`https://${address}`}
            target="_blank"
            rel="noreferrer"
            data-tip="Open the address in a new tab."
          >
            Open
          </a>
        </div>
      ) : null}
      {props.repo ? (
        <div class="row">
          <span class="label" data-tip="Deploys: whether pushes of the repo of this card deploy.">
            Deploys
          </span>
          <span
            class={`sticker ${REPO_STICKERS[props.repo.state].style}`}
            data-tip={REPO_STICKERS[props.repo.state].tip}
          >
            {props.repo.state}
          </span>
          <button
            type="button"
            class={props.repo.state === "blocked" ? "btn" : "btn danger"}
            data-tip={
              props.repo.state === "blocked"
                ? `Allow deploys of ${props.repo.name} again.`
                : `Block deploys of ${props.repo.name}: kitshn refuses them until you allow it again.`
            }
            onClick={async () => {
              if (!props.repo) return;
              const next = props.repo.state === "blocked" ? "allowed" : "blocked";
              const { text, error } = await setRepoState(props.repo, next);
              props.onToast(text, error);
            }}
          >
            {props.repo.state === "blocked" ? "Allow deploys" : "Block deploys"}
          </button>
        </div>
      ) : null}
      {props.access ? (
        <div class="row">
          <span class="label" data-tip="Access: whether Cloudflare has the latest shares of this card.">
            Access
          </span>
          {props.access.state === "applied" ? (
            <span class="stamp" data-tip={ACCESS_TIPS.applied}>
              ✓ applied
            </span>
          ) : (
            <span
              class={`sticker ${props.access.state === "applying" ? "wait" : ""}`}
              data-tip={
                props.access.state === "applying" ? ACCESS_TIPS.applying : "Failed: Cloudflare refused the change."
              }
            >
              {props.access.state}
            </span>
          )}
          {props.access.state === "failed" ? <span class="muted">{props.access.error}</span> : null}
        </div>
      ) : null}
      {!state.places.has(resource.id) ? (
        <button
          class="btn primary"
          data-tip="Place the card in the middle of the view, outside every circle, so it stays private."
          onClick={() => props.onPlace(resource)}
        >
          Place on the map
        </button>
      ) : null}
      {isAppCard(resource) && props.deployed ? (
        <button
          class="btn danger"
          data-tip={REMOVE_APP_TIP}
          onClick={() => props.onRemoveApp(resource)}
        >
          Remove app
        </button>
      ) : null}
      {props.machine ? (
        <MachinePanel
          view={props.machine}
          version={props.version}
          jobs={props.jobs}
          onRemove={() => props.machine && props.onRemoveMachine(props.machine)}
          onRun={(command) => (props.machine ? props.onRunJob(props.machine, command) : Promise.resolve())}
          onToast={props.onToast}
        />
      ) : null}
      <div
        class="label"
        style={{ marginTop: "12px" }}
        data-tip="Who can open it: each circle that holds the card, its members and the level."
      >
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
                  <span
                    class="sticker"
                    data-tip={level ? LEVEL_TIPS[level] : "None: this kind has no level at or below the circle's level."}
                    style={{ background: level ? LEVEL_COLORS[level] : undefined }}
                  >
                    {level ?? "none"}
                  </span>
                  <button
                    class="btn"
                    data-tip={`Remove ${resource.name} from ${circle.name}, without a drag.`}
                    onClick={() => props.onReshare(resource, circle, false)}
                  >
                    Remove
                  </button>
                </div>
                <div class="row">
                  {circle.members.map((member, index) => (
                    <span class="chip" key={index} data-tip={MEMBER_HELP[member._tag]}>
                      {MEMBER_ICONS[member._tag]} {memberLabel(member)}
                    </span>
                  ))}
                </div>
                <div class="field-row">
                  <span class="label" data-tip="Level: the level of this card in this circle. Default follows the circle.">
                    Level
                  </span>
                  <LevelOverride resource={resource} circle={circle} state={state} onEdit={props.onEdit} />
                </div>
                <div class="field-row">
                  <span class="label" data-tip="Ends: at this date kitshn moves the card out of this circle.">
                    Ends
                  </span>
                  <EndsPicker
                    key={`${resource.id}/${circle.id}`}
                    endsAt={setting?.endsAt ?? null}
                    ends="kitshn moves the card out of this circle"
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
          <div class="label" data-tip="Share with: put the card into one more circle, without a drag.">
            Share with
          </div>
          <div class="row">
            {[...state.circles.values()]
              .filter((circle) => !holding.includes(circle))
              .map((circle) => (
                <button
                  key={circle.id}
                  class="btn"
                  data-tip={`Share ${resource.name} with ${circle.name} at ${circle.level}, without a drag.`}
                  onClick={() => props.onReshare(resource, circle, true)}
                >
                  <span class="swatch" style={{ background: circle.color }} /> {circle.name}
                </button>
              ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** K-523: a menu of the actions of one card, stack, circle or spot; the palette has the same ones. */
function ContextMenu(props: {
  menu: { readonly target: MenuTarget; readonly anchor: Rect };
  context: ActionContext;
  handlers: ActionHandlers;
  onClose: () => void;
}) {
  const { target } = props.menu;
  const groups = actionsFor(props.context, props.handlers, target);
  if (!groups) return null;
  const { state } = props.context;
  const name =
    target._tag === "card"
      ? state.resources.get(target.id)?.name
      : target._tag === "stack"
        ? state.stacks.get(target.id)?.name
        : target._tag === "circle"
          ? state.circles.get(target.id)?.name
          : "the map";
  return <ActionMenu label={`Actions for ${name ?? "the map"}`} anchor={props.menu.anchor} groups={groups} onClose={props.onClose} />;
}

function Palette(props: {
  initialQuery: string;
  onClose: () => void;
  entries: ReadonlyArray<PaletteEntry>;
}) {
  const [query, setQuery] = useState(props.initialQuery);
  const [active, setActive] = useState(0);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = props.entries
    .filter((entry) => words.every((word) => entry.label.toLowerCase().includes(word)))
    .slice(0, 50);
  const listId = useId();
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
          aria-label="Find"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
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
        <ul role="listbox" id={listId} aria-label="Matches">
          {matches.map((entry, index) => (
            <li
              key={entry.label}
              id={`${listId}-${index}`}
              role="option"
              data-tip={entry.tip}
              aria-selected={index === active}
              onClick={() => run(index)}
              onMouseEnter={() => setActive(index)}
            >
              {entry.label}
            </li>
          ))}
          {matches.length === 0 ? (
            <li role="option" aria-disabled="true" aria-selected="false">
              Nothing matches.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
