import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type Actor,
  type Edit,
  type Item,
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
  type PauseReach,
  type Point,
  circlesHolding,
  insideCircle,
  isPublicCircle,
  memberLabel,
  pauseReach,
  shareKey,
  shareLevel,
} from "../core/model.ts";
import { MAX_UPLOAD_BYTES } from "../core/library.ts";
import { circleForCards, placeInside } from "../core/place.ts";
import { awaitsAllow } from "../core/repos.ts";
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
import {
  ActionMenu,
  Menu,
  MenuItem,
  MenuSep,
  MoreButton,
  OverlayPanel,
  ResizeEdge,
  TooltipLayer,
  useScreenWidth,
  useStoredWidth,
} from "./controls.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import {
  type Action,
  type ActionContext,
  type ActionHandlers,
  type MenuTarget,
  type UndoAnswer,
  type UndoCheck,
  actionsFor,
  itemKey,
  settleUndoCheck,
  slowUndoCheck,
  REMOVE_APP_TIP,
  levelEdit,
  paletteEntries,
  NEW_CIRCLE,
  reshareEdits,
  selectionActions,
  type StackPart,
  stackChoice,
  stackOntoEdits,
} from "./actions.ts";
import type { Rect } from "./popover.ts";
import { AddSite } from "./Add.tsx";
import { Palette } from "./Palette.tsx";
import { LOCKDOWN_TIP, PAUSE_TIP, PanicOpener, PausedBanner, type PauseView, RESUME_TIP, SafetyView } from "./Pause.tsx";
import { playResumeSound, pressSound, showPanic, unlockAudio } from "./panic.ts";
import { GONE_STICKER, REPO_STICKERS, RepoList, setRepoState } from "./Repos.tsx";
import { LibraryView } from "./Library.tsx";
import { AddMachine, MachinePanel, MachinesView, queueJob } from "./Machines.tsx";
import { ACCESS_TIPS, ALONE_KEY, MapView, type Selection, TRAY_CARDS_TYPE, type View } from "./Map.tsx";
import { overlay } from "./held.ts";
import { HistoryView } from "./History.tsx";
import {
  type Box,
  cardBox,
  circleBox,
  fitMap,
  headAngle,
  headBox,
  openArea,
  panInto,
  shownCardBoxes,
  union,
  type WidthLimits,
  shownWidths,
} from "./layout.ts";
import { actorLabel } from "./revisions.ts";
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

const PREVIEWS_KEY = "kitshn.previews";
/**
 * On a wide screen a saved view stays at least this close, so card names stay readable on a laptop. A fit
 * zooms out further when the map needs it (layout.ts fitMap).
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
  /** A way back that is not an undo, for example Resume after a pause (K-1504). */
  readonly action?: { readonly label: string; readonly tip: string; readonly run: () => void };
}

const VIEW_KEY = "kitshn.view";

/** K-514: this device's saved view, or null when it has none, so the map fits on load. */
const loadView = (): View | null => {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as View | null;
    if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite))
      return wideScreen() ? { ...saved, s: Math.max(saved.s, FIT_MIN_SCALE) } : saved;
  } catch {
    // A broken saved view falls back to a fit.
  }
  return null;
};

/** Typing in a field or working in a dialog keeps its own Escape. */
const ownsEscape = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"]',
  ) !== null;

const CONNECTION_TIPS: Record<Connection, string> = {
  connecting: "Connecting: the map opens a connection to kitshn.",
  live: "Live: the map shows each change at once.",
  offline: "Offline: kitshn is not reachable. The map tries again.",
  refused: "Refused: kitshn did not take the connection. The panel says why.",
};

const TABS = {
  map: "Map: circles say who, and a card inside a circle is shared with it. The panel shows what you select; after Close, this opens it again.",
  machines: "Machines: every machine and its status, in a panel over the map. Enlarge shows the full table.",
  library:
    "Library: every page and file, with a search, a preview and Delete, in a panel over the map. Enlarge shows the full table.",
  history:
    "History: every change as a sentence, with filters and Undo, in a panel over the map. Enlarge shows the full page.",
} as const;

/** K-516, K-519: what the overlay panel shows. History, Library and Machines also have a full view (a tab). */
/** "safety" is the big red button (K-1504); like "details", it has no full view. */
type PanelKind = "details" | "safety" | "history" | "library" | "machines";

/** `html` font size in styles.css. */
const REM = 18;
/** K-525: the side panel and the shelf; the owner drags their edges, and each device keeps its widths. */
const PANEL_WIDTH: WidthLimits = { min: 18 * REM, max: 46 * REM, initial: 26 * REM };
const TRAY_WIDTH: WidthLimits = { min: 160, max: 420, initial: 210 };
const LIMITS = { panel: PANEL_WIDTH, tray: TRAY_WIDTH } as const;
const PANEL_HEADINGS: Record<Exclude<PanelKind, "details">, string> = {
  safety: "Big red button",
  history: "History",
  library: "Library",
  machines: "Machines",
};

/** A highlight from History shows this long, once (K-1508). */
const FLASH_MS = 1200;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const routeFromHash = (): { readonly tab: "map" | Exclude<PanelKind, "details" | "safety">; readonly id: string } => {
  const [tab = "map", id = ""] = location.hash.slice(1).split("/");
  return { tab: tab === "history" || tab === "machines" || tab === "library" ? tab : "map", id };
};

export function App() {
  const store = useStore();
  const [selection, setSelection] = useState<Selection>({ cards: new Set(), circle: null });
  const [hidden, setHidden] = useState<ReadonlySet<ResourceKind>>(new Set());
  const [savedView] = useState(loadView);
  const [view, setView] = useState<View>(() => savedView ?? { x: 0, y: 0, s: 1 });
  /** K-514: once the owner pans or zooms, the map stops fitting on its own until the next load. */
  const userMoved = useRef(false);
  /** The first fit check ran; it fits only a device without a saved view. */
  const loaded = useRef(false);
  const [openStacks, setOpenStacks] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  /** The palette's first query, or null while it is closed. */
  const [palette, setPalette] = useState<string | null>(null);
  const [addingMachine, setAddingMachine] = useState(false);
  const [secret, setSecret] = useState<DeviceSecret | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [trayFilter, setTrayFilter] = useState("");
  const [previews, setPreviews] = useState(() => localStorage.getItem(PREVIEWS_KEY) === "on");
  const [wantedPanel, setPanelWidth] = useStoredWidth("kitshn.panelWidth", PANEL_WIDTH);
  const [wantedTray, setTrayWidth] = useStoredWidth("kitshn.trayWidth", TRAY_WIDTH);
  const screenWidth = useScreenWidth();
  const [addingSite, setAddingSite] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  /** Where the next upload of the file chooser lands: a map point, or null for the tray. */
  const uploadAt = useRef<Point | null>(null);
  /** K-110: a sign-out or its retry waits for Cloudflare; the server also runs one at a time. */
  const [signingOut, setSigningOut] = useState(false);
  const [menu, setMenu] = useState<{ readonly target: MenuTarget; readonly anchor: Rect } | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; resolve: (ok: boolean) => void } | null>(null);
  const [route, setRoute] = useState(routeFromHash);
  /** The panel over the map, or null when closed. */
  const [panel, setPanel] = useState<PanelKind | null>("details");
  /** The details panel in its full view; History, Library and Machines use their tab for that. */
  const [detailsLarge, setDetailsLarge] = useState(false);
  /** K-1508: `itemKey`s of the cards and circles that a History row highlights now. */
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const flashTimer = useRef<number | null>(null);
  const escapeRef = useRef<() => void>(() => undefined);
  /** The anchor of the open "Show" menu of kinds, or null. */
  const [showMenu, setShowMenu] = useState<Rect | null>(null);
  /** K-528: the phone's "☰" menu, which holds the tabs and the map tools that the toolbar has on a wide screen. */
  const [moreMenu, setMoreMenu] = useState<Rect | null>(null);
  /** K-528: on a phone the shelf is a sheet that the owner opens; closed, it shows only its count. */
  const [trayOpen, setTrayOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

  // The map shows held edits on top of the server state, so a drop never jumps back (see held.ts).
  const state = useMemo(
    () => (store.snapshot ? overlay(toState(store.snapshot), store.held) : null),
    [store.snapshot, store.held],
  );
  const pausedBy = store.snapshot?.pausedBy ?? null;
  const pauseView: PauseView | null = store.snapshot?.paused
    ? { mode: store.snapshot.paused, by: pausedBy ? actorLabel(pausedBy.actor) : null, at: pausedBy?.at ?? null }
    : null;
  // K-1504: the counts of the paused banner, only while paused; the Safety panel counts while it shows.
  const pausedReach = useMemo(
    () => (state && store.snapshot?.paused ? pauseReach(state, Date.now()) : null),
    [state, store.snapshot?.paused],
  );
  const reachNow = (): PauseReach => {
    if (!state) throw new Error("The pause counts need the map state.");
    return pauseReach(state, Date.now());
  };
  const machines = useMemo(
    () => new Map((store.snapshot?.machines ?? []).map((view) => [view.machine.id, view])),
    [store.snapshot],
  );
  const deployed = useMemo(() => new Set(store.snapshot?.deployedCards ?? []), [store.snapshot]);

  /**
   * K-523, K-1507: the item whose per-item undo the open menu shows, or for the palette the selected card or
   * circle. Other items get no undo entry, so the palette sends one request, not one per item.
   */
  const undoItemOf: Item | null =
    menu?.target._tag === "card" || menu?.target._tag === "circle"
      ? { kind: menu.target._tag, id: menu.target.id }
      : palette !== null && selection.circle !== null
        ? { kind: "circle", id: selection.circle }
        : palette !== null && selection.cards.size === 1
          ? { kind: "card", id: [...selection.cards][0] ?? "" }
          : null;
  const undoKey = undoItemOf ? itemKey(undoItemOf) : null;
  const [undoCheck, setUndoCheck] = useState<UndoCheck | null>(null);
  // Asks the server when a menu or the palette opens, and again when a new revision arrives while it is open;
  // an answer for a closed menu or another item is dropped.
  const newestRevision = store.snapshot?.revision ?? 0;
  useEffect(() => {
    if (undoItemOf === null || undoKey === null) {
      setUndoCheck(null);
      return;
    }
    setUndoCheck((check) => (check?.key === undoKey ? check : { key: undoKey, answer: null, slow: false }));
    // Each request is live until this effect ends, so an answer from an earlier opening is dropped.
    let live = true;
    const slow = setTimeout(() => setUndoCheck((check) => slowUndoCheck(check, undoKey)), 150);
    void callApi<UndoAnswer>(
      "GET",
      `/api/undo-item?kind=${undoItemOf.kind}&id=${encodeURIComponent(undoItemOf.id)}`,
    ).then((answer) => {
      clearTimeout(slow);
      if (!live) return;
      setUndoCheck((check) =>
        settleUndoCheck(check, undoKey, "error" in answer ? { allowed: false, reason: answer.error } : answer),
      );
    });
    return () => {
      live = false;
      clearTimeout(slow);
    };
  }, [undoKey, newestRevision]);

  useEffect(() => {
    const onHash = () => {
      const next = routeFromHash();
      setRoute(next);
      setMenu(null);
      // K-519: `#map/<card id>` selects the card and shows its panel.
      if (next.tab === "map" && next.id) {
        setSelection({ cards: new Set([next.id]), circle: null });
        setPanel("details");
      }
    };
    if (location.hash.startsWith("#map/")) onHash();
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => (open === null ? "" : null));
      } else if (event.key === "Escape" && !ownsEscape(event.target)) escapeRef.current();
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

  /** The control that opened the panel; Close and Escape give it the focus back. */
  const opener = useRef<HTMLElement | null>(null);
  const rememberOpener = () => {
    const active = document.activeElement;
    // A control inside the panel goes when the panel changes, so the control that opened the panel stays.
    if (active instanceof HTMLElement && active !== document.body && !active.closest(".overlay-panel"))
      opener.current = active;
  };

  /** Selects cards or a circle; a selection shows its details in the panel. */
  const select = (next: Selection) => {
    setSelection(next);
    if (next.cards.size > 0 || next.circle !== null) {
      if (panel !== "details") rememberOpener();
      setPanel("details");
    }
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
    if (added.length > 0) select({ cards: new Set(added.map((item) => item.id)), circle: null });
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
      const plan = stackOntoEdits(state, ids, target, `s-${crypto.randomUUID().slice(0, 8)}`);
      if (!plan) return;
      if ("refused" in plan) {
        showToast({ text: plan.refused, error: true, undo: null });
        return;
      }
      await commit(plan.edits, shareDiff(state, applyChanges(state, resolveEdits(state, plan.edits))), plan.done);
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
    select({ cards: new Set(edits.map((edit) => edit.id)), circle: null });
  };

  /** Selects an item and puts the focus into an input of its panel, after the panel renders. */
  const selectAndFocus = (next: Selection, selector: string) => {
    select(next);
    location.hash = "map";
    queueMicrotask(() => setTimeout(() => document.querySelector<HTMLInputElement>(selector)?.focus()));
  };

  /** Opens the circle editor with its Add member input ready. */
  const addMemberTo = (circleId: string) =>
    selectAndFocus({ cards: new Set(), circle: circleId }, ".add-member input");

  /**
   * K-1504: one press pauses everything at once, with no confirm. The thunk plays at once; the klaxon and the
   * effects play only when this press made the pause, not for a second press or a refusal.
   */
  const pauseNow = async (mode: PauseMode) => {
    pressSound();
    const result = await applyEdits([{ _tag: "pause", after: mode }]);
    if (!result.ok) {
      showToast({ text: result.error, error: true, undo: null });
      return;
    }
    // A second press replaces the first toast, so it keeps the way back too.
    const resume = { label: "Resume with passkey", tip: RESUME_TIP, run: startResume };
    if (result.revision === null) {
      showToast({
        text: mode === "lockdown" ? "Already locked down." : "Already paused.",
        error: false,
        undo: null,
        action: resume,
      });
      return;
    }
    showPanic(mode === "lockdown" ? "lockdown" : "paused");
    showToast({
      text:
        mode === "lockdown"
          ? "Locked down. Only the Owner circle's people open the admin; public sites are closed too."
          : "Paused. Only the Owner circle's people open the admin; public sites stay open.",
      error: false,
      undo: null,
      action: resume,
    });
  };

  /** Resume needs a fresh passkey: Access checks it on `/api/fresh` and sends the owner back to `#resume`. */
  const startResume = () => location.assign("/api/fresh/start");

  const finishResume = async () => {
    history.replaceState(null, "", location.pathname + location.search);
    // MM-712: a link alone never resumes; the owner confirms once more after the passkey check.
    if (!(await ask("Your passkey check passed. Resume everything now? Every share comes back."))) return;
    unlockAudio();
    const result = await callApi<{ revision: number | null }>("POST", "/api/fresh/resume", {});
    if (!("error" in result)) playResumeSound();
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

  /** K-1507: undoes the caller's own newest change to one card or circle. */
  const undoItem = async (item: Item) => {
    const result = await callApi<{ revision: number | null; notes: ReadonlyArray<string> }>("POST", "/api/undo-item", {
      item,
    });
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: ["Undone.", ...result.notes].join(" "), error: false, undo: null },
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

  const fullPage = route.tab !== "map";
  const shownPanel: PanelKind | null = fullPage ? route.tab : panel;
  const large = fullPage || ((panel === "details" || panel === "safety") && detailsLarge);
  /** The panel floats over the map, so the map keeps its width and fit and pan leave its part free. */
  const floating = shownPanel !== null && !large;

  const ready = state !== null;
  // K-514: fits on load without a saved view, and when the panel opens or closes until the owner pans or zooms.
  useEffect(() => {
    if (!ready) return;
    const first = !loaded.current;
    loaded.current = true;
    if (first ? savedView === null : !userMoved.current) fitRef.current?.();
  }, [ready, floating]);

  // History renders only when its data changes, not on each pan of the map; its callbacks read the latest ones.
  const historyShow = useRef<(revision: RevisionView) => void>(() => undefined);
  const historyUndo = useRef<(id: number) => void>(() => undefined);
  const historyView = useMemo(
    () =>
      state && store.snapshot ? (
        <HistoryView
          revisions={store.snapshot.revisions}
          me={store.snapshot.me}
          state={state}
          onUndo={(id) => historyUndo.current(id)}
          onShow={(revision) => historyShow.current(revision)}
        />
      ) : null,
    [store.snapshot, state],
  );

  /**
   * K-519: the toolbar's bottom, for the tray and the full view below it (styles.css `--bar-bottom`), and the
   * hint line's height, so a toast sits above it (`--hint-height`; 0 when the hint is hidden on a phone).
   */
  const [barRef, hintRef] = useMemo(() => {
    const measured = (property: string, measure: (rect: DOMRect) => number) => {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries)
          document.documentElement.style.setProperty(
            property,
            `${Math.round(measure(entry.target.getBoundingClientRect()))}px`,
          );
      });
      return (element: HTMLElement | null) => {
        if (!element) return;
        observer.observe(element);
        return () => observer.unobserve(element);
      };
    };
    return [measured("--bar-bottom", (rect) => rect.bottom), measured("--hint-height", (rect) => rect.height)];
  }, []);

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

  const tray = [...state.resources.values()].filter((resource) => !state.places.has(resource.id));
  const trayShown = tray.length > 0 && route.tab === "map";
  const wide = screenWidth > 720;
  /** K-525: the widths that show leave room for each other and for the map; a phone keeps its own layout. */
  const widthsFor = (panel: number, shelf: number) =>
    shownWidths(screenWidth, { panel: floating ? panel : null, tray: trayShown ? shelf : null }, LIMITS);
  const widths = widthsFor(wantedPanel, wantedTray);
  // The page's CSS reads these, also outside this tree's elements; a drag sets them alone until it ends.
  if (wide) {
    document.documentElement.style.setProperty("--panel-width", `${widths.panel || wantedPanel}px`);
    document.documentElement.style.setProperty("--tray-width", `${widths.tray || wantedTray}px`);
  } else {
    document.documentElement.style.removeProperty("--panel-width");
    document.documentElement.style.removeProperty("--tray-width");
  }
  /** The left edge of the overlay panel on a wide screen, for a panel `width` wide. */
  const panelLeft = (width = widths.panel || wantedPanel) => innerWidth - 12 - Math.min(width, innerWidth - 24);
  const shownTray = tray
    .filter((resource) =>
      `${resource.name} ${resource.kind} ${resource.addresses[0] ?? ""}`
        .toLowerCase()
        .includes(trayFilter.trim().toLowerCase()),
    )
    .reverse();

  /** The right edge of the shelf where it covers the map, or 0: a closed shelf on a phone covers none of it. */
  const shelfRight = () => {
    if (!trayShown || (!wide && !trayOpen)) return 0;
    return document.querySelector(".tray")?.getBoundingClientRect().right ?? 10 + (wide ? widths.tray : Math.min(16 * REM, screenWidth - 20));
  };

  /** The part of the screen where the map shows clear of the toolbar, the tray and a floating panel. */
  const mapArea = (withPanel: boolean, panelWidth?: number): Box =>
    openArea({
      width: innerWidth,
      // The hint line at the bottom shows only on a wide screen; the map stays above it.
      height: wideScreen() ? (document.querySelector(".hint")?.getBoundingClientRect().top ?? innerHeight) : innerHeight,
      top: document.querySelector("header.bar")?.getBoundingClientRect().bottom ?? 70,
      // The tray is not drawn yet when a full view switches to the map, so its width then comes from the tray cards.
      // On a phone a closed shelf is a chip above the map, so the map takes the full width (K-528).
      left: shelfRight(),
      panelLeft: withPanel ? panelLeft(panelWidth) : null,
      narrow: !wideScreen(),
    });

  const fit = () => {
    const next = fitMap(state.circles.values(), state.places.values(), mapArea(floating));
    if (next) changeView(next);
  };

  fitRef.current = fit;

  /**
   * K-1508: shows the cards and circles of a History row on the map: a pan that brings them clear of the
   * panel, and one highlight that ends by itself.
   */
  const showOnMap = (revision: RevisionView) => {
    const cards = revision.items.flatMap((item) => {
      const place = item.kind === "card" ? state.places.get(item.id) : undefined;
      const kind = state.resources.get(item.id)?.kind;
      return place && kind && !hidden.has(kind) ? [{ item, box: cardBox(place) }] : [];
    });
    const circles = revision.items.flatMap((item) => {
      const circle = item.kind === "circle" ? state.circles.get(item.id) : undefined;
      return circle ? [{ item, box: circleBox(circle) }] : [];
    });
    const shown = [...cards, ...circles];
    if (shown.length === 0) {
      showToast({
        text: "Nothing of this change shows on the map now: it is gone, in the tray, or of a hidden kind.",
        error: false,
        undo: null,
      });
      return;
    }
    if (fullPage) {
      setPanel("history");
      location.hash = "map";
    }
    // A pan to chosen items is the owner's view now, so a panel that opens next does not fit over it.
    userMoved.current = true;
    changeView(panInto(union(shown.map((entry) => entry.box)), mapArea(true), view));
    setFlash(new Set(shown.map((entry) => itemKey(entry.item))));
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(new Set()), FLASH_MS);
  };

  /** A toolbar tab opens its panel over the map; Enlarge in the panel opens the full view. */
  const openTab = (tab: "map" | Exclude<PanelKind, "details" | "safety">) => {
    rememberOpener();
    setPanel(tab === "map" ? "details" : tab);
    location.hash = "map";
  };

  /** K-1504: the toolbar opener, the palette and the map panel open the big red button here. */
  const openSafety = () => {
    rememberOpener();
    setPanel("safety");
    location.hash = "map";
  };

  const resizePanel = (kind: PanelKind) => {
    if (kind === "details" || kind === "safety") setDetailsLarge(!large);
    else if (large) openTab(kind);
    else location.hash = kind;
  };

  const closePanel = () => {
    setPanel(null);
    setDetailsLarge(false);
    if (fullPage) location.hash = "map";
    (opener.current?.isConnected
      ? opener.current
      : document.querySelector<HTMLElement>(".bar .seg button, .bar button[aria-label='Menu']")
    )?.focus();
  };

  historyShow.current = showOnMap;
  historyUndo.current = (id) => void undo(id);

  // Escape clears a selection first, then closes the panel; the palette and dialogs handle their own.
  escapeRef.current = () => {
    if (selection.cards.size > 0 || selection.circle !== null)
      setSelection({ cards: new Set(), circle: null });
    else if (shownPanel !== null) closePanel();
  };

  /** A new circle at `at`, or in the middle of the view. */
  const newCircle = async (at: Point | null) => {
    const id = `c-${crypto.randomUUID().slice(0, 8)}`;
    const center = at ?? { x: (innerWidth / 2 - view.x) / view.s, y: (innerHeight / 2 - view.y) / view.s };
    const circle: Circle = {
      ...NEW_CIRCLE,
      id,
      color: CIRCLE_COLORS[state.circles.size % CIRCLE_COLORS.length] ?? "#6C5CE7",
      x: Math.round(center.x),
      y: Math.round(center.y),
      r: 220,
    };
    const result = await applyEdits([{ _tag: "circle", id, after: circle }]);
    if (result.ok) select({ cards: new Set(), circle: id });
    else showToast({ text: result.error, error: true, undo: null });
  };

  /**
   * K-529: one new circle around the selected cards, as one edit, so one undo takes it back. Its editor opens
   * next, because it has no members until the owner adds some.
   */
  const newCircleFor = async () => {
    const id = `c-${crypto.randomUUID().slice(0, 8)}`;
    const color = CIRCLE_COLORS[state.circles.size % CIRCLE_COLORS.length] ?? "#6C5CE7";
    // A card that another device removed while it was selected drops out, as in `selectionActions`.
    const ids = [...selection.cards].filter((card) => state.resources.has(card));
    const plan = circleForCards(state, ids, { ...NEW_CIRCLE, id, color });
    if ("refused" in plan) {
      showToast({ text: plan.refused, error: true, undo: null });
      return;
    }
    const result = await applyEdits(plan.edits);
    if (!result.ok) {
      showToast({ text: result.error, error: true, undo: null });
      return;
    }
    const { moved, cards } = plan;
    selectAndFocus({ cards: new Set(), circle: id }, ".add-member input");
    showToast({
      text: `Made a circle for ${cards} cards${moved > 0 ? `; ${plural(moved, "card")} moved to keep their circles` : ""}. Add members next.`,
      error: false,
      undo: result.revision,
    });
  };

  /** K-511: share or unshare without a drag, by placing the card where exactly the wanted circles hold it. */
  const reshare = async (resource: Resource, circle: Circle, share: boolean, part: StackPart) => {
    const plan = reshareEdits(state, resource, circle, share, part);
    if ("refused" in plan) {
      showToast({ text: plan.refused, error: true, undo: null });
      return;
    }
    // A stacked card takes its stack along (K-521), so the diff comes from the resolved changes.
    await commit(plan.edits, shareDiff(state, applyChanges(state, resolveEdits(state, plan.edits))));
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
    setSigningOut(true);
    const result = await callApi<{ ended: number; failed: Array<string> }>(
      "POST",
      retry ? "/api/sign-out/retry" : "/api/sign-out",
      {},
    ).finally(() => setSigningOut(false));
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

  /** K-525: after a panel resize, selected cards that the panel now covers pan clear of it. */
  const keepSelectionClear = (panelWidth: number) => {
    const boxes = [...selection.cards].flatMap((id) => {
      const place = state.places.get(id);
      return place ? [cardBox(place)] : [];
    });
    if (boxes.length === 0) return;
    const next = panInto(union(boxes), mapArea(true, panelWidth), view);
    if (next !== view) changeView(next);
  };

  /** K-523: the menu and the palette run these, the same as the toolbar and the panel. */
  const handlers: ActionHandlers = {
    select: (selected) => {
      select(selected);
      location.hash = "map";
      // "Show details" brings the item clear of the panel.
      const boxes = [
        ...[...selected.cards].flatMap((id) => {
          const place = state.places.get(id);
          return place ? [cardBox(place)] : [];
        }),
        ...[state.circles.get(selected.circle ?? "")].flatMap((circle) =>
          circle ? [headBox(circle, headAngle(circle, shownCardBoxes(state, hidden)))] : [],
        ),
      ];
      if (boxes.length > 0) {
        userMoved.current = true;
        changeView(panInto(union(boxes), mapArea(true), view));
      }
    },
    openAddress: (address) => void open(`https://${address}`, "_blank", "noreferrer"),
    copyAddress: (address) => void navigator.clipboard.writeText(`https://${address}`),
    reshare: (resource, circle, share, part) => void reshare(resource, circle, share, part),
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
      select({ cards: new Set(), circle: circleId });
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
    newCircleFor: () => void newCircleFor(),
    fit,
    undoItem: (item) => void undoItem(item),
  };
  const actionContext: ActionContext = {
    state,
    deployed,
    machines,
    version: store.snapshot.version,
    undoCheck,
    selected: selection.cards,
  };

  const waitingRepos = store.snapshot?.repos.filter(awaitsAllow).length ?? 0;
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
          onSelect={select}
          hidden={hidden}
          view={view}
          onView={(next) => {
            userMoved.current = true;
            changeView(next);
          }}
          panelLeft={floating && wideScreen() ? panelLeft() : null}
          trayRight={shelfRight()}
          flash={flash}
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
      ) : null}
      {floating && wide ? (
        <ResizeEdge
          label="Panel width"
          width={widths.panel}
          limits={PANEL_WIDTH}
          grows="left"
          cssVar="--panel-width"
          fit={(wanted) => widthsFor(wanted, wantedTray).panel}
          onCommit={(width) => {
            setPanelWidth(width);
            keepSelectionClear(width);
          }}
        />
      ) : null}
      {shownPanel ? (
        <OverlayPanel
          // New content mounts a new panel, so the focus moves to its heading.
          key={shownPanel}
          heading={
            shownPanel !== "details"
              ? PANEL_HEADINGS[shownPanel]
              : selection.circle !== null && state.circles.has(selection.circle)
                ? "Circle"
                : selection.cards.size === 1
                  ? "Card"
                  : selection.cards.size > 1
                    ? "Selection"
                    : "The map"
          }
          large={large}
          onResize={() => resizePanel(shownPanel)}
          onClose={closePanel}
        >
          {shownPanel === "safety" ? (
            <SafetyView
              reach={reachNow}
              pause={pauseView}
              onPress={() => void pauseNow("keep-public")}
              onLockdown={() => void pauseNow("lockdown")}
            />
          ) : shownPanel === "history" ? (
            historyView
          ) : shownPanel === "library" ? (
            <LibraryView
              state={state}
              revision={store.snapshot.revision}
              onToast={(text, error) => showToast({ text, error, undo: null })}
              onShowCard={(id) => handlers.select({ cards: new Set([id]), circle: null })}
            />
          ) : shownPanel === "machines" ? (
            <MachinesView machines={store.snapshot.machines} onAdd={() => setAddingMachine(true)} />
          ) : (
            <Panel
              state={state}
              repos={store.snapshot.repos}
              selection={selection}
              access={store.snapshot.access}
              me={store.snapshot.me}
              accessTeam={store.snapshot.accessTeam}
              onSelectCard={(id) => select({ cards: new Set([id]), circle: null })}
              onSelectCircle={(id) => select({ cards: new Set(), circle: id })}
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
              onReshare={(resource, circle, share, part) => void reshare(resource, circle, share, part)}
              onRemoveApp={(resource) => void removeApp(resource)}
              deployed={deployed}
              pause={pauseView}
              machines={machines}
              version={store.snapshot.version}
              jobs={store.snapshot.jobs}
              onToast={(text, error) => showToast({ text, error, undo: null })}
              onRemoveMachine={handlers.removeMachine}
              onRunJob={runJob}
              warnings={store.snapshot.accessWarnings}
              onOpenSafety={openSafety}
              selectionActions={selectionActions(actionContext, handlers)}
              onSignOut={(retry) => void signOut(retry)}
              signOutWarning={store.snapshot.signOutWarning}
              signingOut={signingOut}
            />
          )}
        </OverlayPanel>
      ) : null}
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
      <header class={`bar${floating ? " beside-panel" : ""}`} ref={barRef}>
        <h1>kitshn</h1>
        {wide ? (
        <div class="seg">
          {(["map", "machines", "library", "history"] as const).map((tab) => (
            <button
              key={tab}
              aria-pressed={
                fullPage ? route.tab === tab : tab === "map" ? panel === "details" : panel === tab
              }
              data-tip={TABS[tab]}
              onClick={() => openTab(tab)}
            >
              {tab[0]?.toUpperCase()}
              {tab.slice(1)}
            </button>
          ))}
        </div>
        ) : (
          <button
            type="button"
            class="btn"
            aria-haspopup="menu"
            aria-expanded={moreMenu !== null}
            aria-label="Menu"
            data-tip="The tabs, the kinds to show, Fit and Previews."
            onClick={(event) => setMoreMenu(event.currentTarget.getBoundingClientRect())}
          >
            ☰
          </button>
        )}
        {moreMenu ? (
          <Menu label="Menu" anchor={moreMenu} onClose={() => setMoreMenu(null)}>
            {(["map", "machines", "library", "history"] as const).map((tab) => (
              <MenuItem
                key={tab}
                checked={fullPage ? route.tab === tab : tab === "map" ? panel === "details" : panel === tab}
                tip={TABS[tab]}
                onSelect={() => openTab(tab)}
              >
                {tab[0]?.toUpperCase()}
                {tab.slice(1)}
              </MenuItem>
            ))}
            {waitingRepos > 0 ? (
              <MenuItem
                tip="Repos that wait for you to allow their first deploy. It shows them in the panel."
                onSelect={() => {
                  setSelection({ cards: new Set(), circle: null });
                  openTab("map");
                }}
              >
                {plural(waitingRepos, "repo")} waiting
              </MenuItem>
            ) : null}
            {route.tab === "map" ? (
              <>
                <MenuSep />
                <MenuItem
                  tip="Show or hide kinds of cards on the map."
                  onSelect={() => setShowMenu(moreMenu)}
                >
                  Show{hidden.size > 0 ? ` (${hidden.size} hidden)` : ""} ▸
                </MenuItem>
                <MenuItem tip="Fit every circle and card in the view." onSelect={fit}>
                  Fit
                </MenuItem>
                <MenuItem
                  checkbox
                  checked={previews}
                  tip={`${previews ? "Hide" : "Show"} live previews of up to four site and page cards near the centre, from zoom 80%.`}
                  onSelect={() => {
                    localStorage.setItem(PREVIEWS_KEY, previews ? "off" : "on");
                    setPreviews(!previews);
                  }}
                >
                  Previews{previews && view.s < 0.8 ? " (zoom in)" : ""}
                </MenuItem>
              </>
            ) : null}
          </Menu>
        ) : null}
        {route.tab === "map" ? (
          <>
            {wide ? <span class="sep" /> : null}
            {/* K-501: one menu for the kinds, so the toolbar stays short and "Machines" names only the tab. */}
            {wide ? (
            <button
              type="button"
              class="btn"
              aria-haspopup="menu"
              data-tip="Show or hide kinds of cards on the map. Hidden kinds still count for their circles."
              onClick={(event) => setShowMenu(event.currentTarget.getBoundingClientRect())}
            >
              Show{hidden.size > 0 ? ` (${hidden.size} hidden)` : ""} ▾
            </button>
            ) : null}
            {showMenu ? (
              <Menu label="Show kinds on the map" anchor={showMenu} onClose={() => setShowMenu(null)}>
                {(Object.keys(RESOURCE_KINDS) as Array<ResourceKind>)
                  .filter((kind) => [...state.resources.values()].some((resource) => resource.kind === kind))
                  .map((kind) => (
                    <MenuItem
                      key={kind}
                      checkbox
                      checked={!hidden.has(kind)}
                      keepOpen
                      tip={`${hidden.has(kind) ? "Show" : "Hide"} ${KINDS[kind].label.toLowerCase()} on the map.`}
                      onSelect={() => {
                        const next = new Set(hidden);
                        if (next.has(kind)) next.delete(kind);
                        else next.add(kind);
                        setHidden(next);
                      }}
                    >
                      {KINDS[kind].icon} {KINDS[kind].label}
                    </MenuItem>
                  ))}
              </Menu>
            ) : null}
            {wide ? <span class="sep" /> : null}
            <button
              class="btn primary add"
              aria-haspopup="menu"
              aria-label="Add"
              data-tip="Add a circle, a page or a file, a site, a machine or a member (K-526)."
              onClick={(event) =>
                setMenu({ target: { _tag: "add" }, anchor: event.currentTarget.getBoundingClientRect() })
              }
            >
              +
            </button>
            {wide ? (
            <>
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
          </>
        ) : null}
        <span class="grow" />
        {waitingRepos > 0 && wide ? (
          <button
            class="btn"
            data-tip="Repos that wait for you to allow their first deploy. A click shows them in the panel."
            onClick={() => {
              setSelection({ cards: new Set(), circle: null });
              openTab("map");
            }}
          >
            <span class="sticker wait">{wide ? `${plural(waitingRepos, "repo")} waiting` : `${waitingRepos} waiting`}</span>
          </button>
        ) : null}
        {/* On a phone Resume takes the opener's place while paused; the banner shows the paused state. */}
        {wide || !pauseView ? (
          <PanicOpener pause={pauseView} open={shownPanel === "safety"} onOpen={openSafety} />
        ) : null}
        {pauseView ? (
          <button class="btn resume" onClick={startResume} data-tip={RESUME_TIP}>
            Resume
          </button>
        ) : null}
        <button
          class="btn"
          onClick={() => setPalette("")}
          aria-label="Command palette"
          data-tip="Command palette (Cmd+K or Ctrl+K): find every card, circle and action."
        >
          {wide ? "⌘K" : "Find"}
        </button>
        {/* A phone shows the connection only when it is not live, so the toolbar fits one row. */}
        {wide || store.connection !== "live" ? (
          <span
            class={`sticker ${store.connection === "live" ? "ok" : "wait"}`}
            style={{ "--tilt": "3deg" }}
            data-tip={CONNECTION_TIPS[store.connection]}
          >
            {store.connection}
          </span>
        ) : null}
      </header>
      {tray.length > 0 && route.tab === "map" ? (
        <aside class={`tray${!wide && !trayOpen ? " closed" : ""}`}>
          {wide ? (
            <ResizeEdge
              label="Shelf width"
              width={widths.tray}
              limits={TRAY_WIDTH}
              grows="right"
              cssVar="--tray-width"
              fit={(wanted) => widthsFor(wantedPanel, wanted).tray}
              onCommit={setTrayWidth}
            />
          ) : null}
          <div class="tray-head">
            {wide ? (
              <span
                class="label"
                data-tip="New cards arrive here, outside every circle, so they start private."
              >
                New · private ({tray.length})
              </span>
            ) : (
              <button
                type="button"
                class="label tray-toggle"
                aria-expanded={trayOpen}
                data-tip="New cards arrive here, outside every circle, so they start private. Tap to open or close."
                onClick={() => setTrayOpen(!trayOpen)}
              >
                New · private ({tray.length}) {trayOpen ? "▴" : "▾"}
              </button>
            )}
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
                onContextMenu={(event) => {
                  // K-523: a tray card has the same menu as on the map, with Place on the map.
                  event.preventDefault();
                  setMenu({
                    target: { _tag: "card", id: resource.id },
                    anchor: { left: event.clientX, top: event.clientY, width: 0, height: 0 },
                  });
                }}
                onClick={(event) => {
                  const cards = new Set(event.shiftKey ? selection.cards : []);
                  if (event.shiftKey && cards.has(resource.id)) cards.delete(resource.id);
                  else cards.add(resource.id);
                  select({ cards, circle: null });
                }}
              >
                <div class="name">
                  <ItemIcon resource={resource} />
                  {resource.name}
                </div>
                <div class="sub">{resource.addresses[0] ?? resource.kind}</div>
                <div class="foot">
                  <MoreButton
                    name={resource.name}
                    onOpen={(anchor) => setMenu({ target: { _tag: "card", id: resource.id }, anchor })}
                  />
                </div>
              </div>
            ))}
          </div>
        </aside>
      ) : null}
      {pauseView && pausedReach ? (
        <PausedBanner
          pause={pauseView}
          reach={pausedReach}
          besidePanel={floating}
          onLockdown={() => void pauseNow("lockdown")}
          onResume={startResume}
        />
      ) : null}
      {palette !== null ? (
        <Palette
          initialQuery={palette}
          onClose={() => setPalette(null)}
          entries={[
            { label: "Open History", tip: TABS.history, run: () => openTab("history") },
            ...(pauseView
              ? [
                  { label: "Resume with passkey", tip: RESUME_TIP, run: startResume },
                  ...(pauseView.mode === "keep-public"
                    ? [
                        {
                          label: "Close public sites too",
                          danger: true as const,
                          tip: LOCKDOWN_TIP,
                          run: () => void pauseNow("lockdown"),
                        },
                      ]
                    : []),
                ]
              : [{ label: "Emergency pause: open the big red button", danger: true as const, tip: PAUSE_TIP, run: openSafety }]),
            ...(store.snapshot.signOutWarning
              ? [
                  {
                    label: "Retry sign-out everywhere",
                    danger: true as const,
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
        <div class={`toast${toast.error ? " error" : ""}${floating ? " beside-panel" : ""}`} role="status">
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
          {toast.action ? (
            <button
              class="btn resume"
              data-tip={toast.action.tip}
              onClick={() => {
                setToast(null);
                toast.action?.run();
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button class="btn" onClick={() => setToast(null)} aria-label="Close" data-tip="Close this message.">
            ×
          </button>
        </div>
      ) : null}
      {route.tab === "map" ? (
        // Beside a floating panel the hint stops at the panel and wraps, so it stays readable.
        <div class={`hint${floating ? " beside-panel" : ""}`} ref={hintRef}>
          Drag a card into a circle to share it · Right-click, a long press or ⋯: actions · Shift-click or drag
          empty space: select many · {ALONE_KEY.label}-drag a circle head: move it alone · Ctrl or ⌘ + wheel: zoom
        </div>
      ) : null}
    </>
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
  onReshare: (resource: Resource, circle: Circle, share: boolean, part: StackPart) => void;
  onRemoveApp: (resource: Resource) => void;
  /** K-909 */
  deployed: ReadonlySet<string>;
  pause: PauseView | null;
  warnings: ReadonlyArray<string>;
  machines: ReadonlyMap<string, MachineView>;
  jobs: ReadonlyArray<JobView>;
  onRemoveMachine: (view: MachineView) => void;
  onRunJob: (view: MachineView, command: Command) => Promise<void>;
  version: string;
  onToast: (text: string, error: boolean) => void;
  onOpenSafety: () => void;
  /** K-521, K-529: the shared selection actions, so the panel shows the same refusals as the menu and the palette. */
  selectionActions: ReadonlyArray<Action>;
  onSignOut: (retry: boolean) => void;
  signOutWarning: string | null;
  signingOut: boolean;
  accessTeam: string;
  onSelectCard: (id: string) => void;
  onSelectCircle: (id: string) => void;
  stacks: StackActions;
  onSecret: (secret: DeviceSecret) => void;
}) {
  const { state, selection } = props;
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
        // A new card is a new panel, so an open choice of another card never shows again.
        key={cards[0].id}
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
              <ItemIcon resource={resource} />
              {resource.name}
            </li>
          ))}
        </ul>
        <div class="row">
          {props.selectionActions.map((action, index) =>
            "run" in action ? (
              <button
                key={action.id}
                class={index === 0 ? "btn primary" : "btn"}
                disabled={action.refused !== undefined}
                data-tip={action.refused ?? action.tip}
                onClick={action.run}
              >
                {action.short ?? action.label}
              </button>
            ) : null,
          )}
        </div>
      </section>
    );
    if (stackOfAll) body = (
      <StackPanel stack={stackOfAll} state={state} actions={props.stacks} onSelectCard={props.onSelectCard} />
    );
  } else {
    body = (
      <section>
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
                    disabled={props.signingOut}
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
            type="button"
            class="btn danger"
            data-tip={
              props.pause
                ? "Open the big red button: see who paused, what is closed, and close public sites too."
                : "Open the big red button: lift its lid, then press to pause everything."
            }
            onClick={props.onOpenSafety}
          >
            {props.pause ? `Big red button: ${props.pause.mode === "lockdown" ? "locked down" : "paused"}` : "Big red button…"}
          </button>
        </div>
        <div class="row">
          <button
            class="btn danger"
            data-tip="Sign out everywhere: ends every Access session of kitshn's apps at once. Everyone logs in again, you too. History records it."
            disabled={props.signingOut}
            onClick={() => props.onSignOut(false)}
          >
            Sign out everywhere: ends every session
          </button>
        </div>
      </section>
    );
  }
  return body;
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
                  {resource ? (
                    <>
                      <ItemIcon resource={resource} />
                      {resource.name}
                    </>
                  ) : (
                    id
                  )}
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
  onReshare: (resource: Resource, circle: Circle, share: boolean, part: StackPart) => void;
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
  const { resource, state, machine } = props;
  const holding = circlesHolding(state, resource.id);
  const address = resource.addresses[0];
  const stack = [...state.stacks.values()].find((each) => each.members.includes(resource.id));
  const [removing, setRemoving] = useState<{ readonly circle: Circle; readonly anchor: Rect } | null>(null);
  // The stack went while the choice was open (another device, or undo): the choice ends with it.
  if (removing && !stack) setRemoving(null);
  return (
    <section>
      {removing && stack ? (
        <Menu label={`Remove from ${removing.circle.name}`} anchor={removing.anchor} onClose={() => setRemoving(null)}>
          {stackChoice(stack).map(({ part, label, tip }) => (
            <MenuItem
              key={part}
              tip={`${tip} out of ${removing.circle.name}.`}
              onSelect={() => props.onReshare(resource, removing.circle, false, part)}
            >
              {label}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      <div class="label" data-tip={KINDS[resource.kind].help}>
        {KINDS[resource.kind].label}
      </div>
      <h2>
        <ItemIcon resource={resource} />
        {resource.name}
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
          {props.repo.goneOnGitHub ? (
            <span class={`sticker ${GONE_STICKER.style}`} data-tip={GONE_STICKER.tip}>
              deleted on GitHub
            </span>
          ) : (
            <span
              class={`sticker ${REPO_STICKERS[props.repo.state].style}`}
              data-tip={REPO_STICKERS[props.repo.state].tip}
            >
              {props.repo.state}
            </span>
          )}
          {/* A repo marked deleted keeps Block, so a wrong mark stays recoverable; it never offers Allow. */}
          {props.repo.goneOnGitHub && props.repo.state === "blocked" ? null : (
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
          )}
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
      {machine ? (
        <MachinePanel
          view={machine}
          version={props.version}
          jobs={props.jobs}
          onRemove={() => props.onRemoveMachine(machine)}
          onRun={(command) => props.onRunJob(machine, command)}
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
                    aria-haspopup={stack ? "menu" : undefined}
                    aria-expanded={stack ? removing?.circle.id === circle.id : undefined}
                    data-tip={
                      stack
                        ? `Remove ${resource.name} or all of ${stack.name} from ${circle.name}, without a drag.`
                        : `Remove ${resource.name} from ${circle.name}, without a drag.`
                    }
                    onClick={(event) => {
                      // K-527: a stacked card asks which part leaves; Escape or a click outside does nothing.
                      if (stack) setRemoving({ circle, anchor: event.currentTarget.getBoundingClientRect() });
                      else props.onReshare(resource, circle, false, "stack");
                    }}
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
                  onClick={() => props.onReshare(resource, circle, true, "stack")}
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
  const label = target._tag === "add" ? "Add" : `Actions for ${name ?? "the map"}`;
  return <ActionMenu label={label} anchor={props.menu.anchor} groups={groups} onClose={props.onClose} />;
}

