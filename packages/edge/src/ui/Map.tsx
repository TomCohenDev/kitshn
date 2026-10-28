import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Change, type Edit, type ShareDiff, applyChanges, shareDiff } from "../core/changes.ts";
import {
  type Circle,
  type Point,
  type Resource,
  type ResourceKind,
  type State,
  circleAloneKey,
  circlesHolding,
  insideCircle,
  memberLabel,
  shareKey,
  shareLevel,
} from "../core/model.ts";
import type { AccessState, MachineView } from "../core/protocol.ts";
import { isAgentKey } from "../core/agent.ts";
import { AGENT_TIP, LEVEL_TIPS, MATCH_TIPS, MEMBER_HELP, PASSKEY_TIP, RightStickers } from "./Circle.tsx";
import { KINDS, LEVEL_COLORS, LEVEL_TILTS, MEMBER_ICONS } from "./kinds.ts";
import { KeySticker, PresenceSticker } from "./Machines.tsx";
import type { MenuTarget } from "./actions.ts";
import { MoreButton } from "./controls.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import { FRAMED_KINDS, peekable } from "./frames.ts";
import { CardPreview, PeekArrow } from "./Peek.tsx";
import type { Rect } from "./popover.ts";
import { HOLD_MS, type Press, fingerDown, startPress, stepPress } from "./press.ts";
import { type Fingers, type View, ZOOM, headAngle, pinchView, shownCardBoxes } from "./layout.ts";

export type { View };

export type Selection = { readonly cards: ReadonlySet<string>; readonly circle: string | null };

type Drag =
  | { readonly type: "pan"; readonly sx: number; readonly sy: number; readonly view: View }
  | {
      readonly type: "cards";
      readonly start: Point;
      readonly origins: ReadonlyMap<string, Point>;
      readonly clicked: string;
      /** The card under the grab point, which a drop never stacks onto, so a nudge stays a move. */
      under: string | null;
      moved: boolean;
    }
  | {
      readonly type: "circle";
      readonly start: Point;
      readonly origin: Circle;
      readonly carry: ReadonlyMap<string, Point>;
      moved: boolean;
    }
  | { readonly type: "resize"; readonly origin: Circle }
  /** K-516: two fingers zoom and pan; the cards stay where they are. */
  | { readonly type: "pinch"; readonly from: Fingers; readonly view: View }
  | { readonly type: "box"; readonly start: Point; readonly end: Point; readonly base: ReadonlySet<string> };

/** Cards with one group stack when they share the same circles (K-508). */
export function stacksOf(state: State): Map<string, Array<string>> {
  const stacks = new Map<string, Array<string>>();
  // K-521: the owner's stacks come first; their cards leave the stacks by group.
  const owned = new Set<string>();
  for (const stack of state.stacks.values()) {
    const placed = stack.members.filter((id) => state.places.has(id));
    for (const id of placed) owned.add(id);
    if (placed.length > 1) stacks.set(`${USER_STACK}${stack.id}`, placed);
  }
  for (const resource of state.resources.values()) {
    if (!resource.group || owned.has(resource.id) || !state.places.has(resource.id)) continue;
    const circles = circlesHolding(state, resource.id)
      .map((circle) => circle.id)
      .sort()
      .join(",");
    const key = `${resource.group}|${circles}`;
    stacks.set(key, [...(stacks.get(key) ?? []), resource.id]);
  }
  for (const [key, ids] of stacks) if (ids.length < 2) stacks.delete(key);
  return stacks;
}

/** The key prefix of a stack that the owner made, as opposed to a stack by group (K-508). */
export const USER_STACK = "stack:";

/** K-407 */
export const ACCESS_TIPS = {
  applying: "Applying: Cloudflare does not have this change yet.",
  applied: "Applied: Cloudflare has this change.",
} as const;

interface Props {
  /** K-1101: files dropped from the computer, with the map point under the pointer. */
  onDropFiles: (files: Array<File>, at: Point) => void;
  /** Cards dragged from the tray (K-509), with the map point under the pointer. */
  onDropCards: (ids: Array<string>, at: Point) => void;
  readonly state: State;
  readonly access: Readonly<Record<string, AccessState>>;
  readonly machines: ReadonlyMap<string, MachineView>;
  readonly selection: Selection;
  readonly onSelect: (selection: Selection) => void;
  readonly hidden: ReadonlySet<ResourceKind>;
  readonly view: View;
  /** Live previews of site and page cards (when the zoom allows). */
  readonly previews: boolean;
  /** K-520: the preview arrow under the selected card (a wide screen; a phone has it in the card sheet). */
  readonly peek: boolean;
  readonly zone: string;
  readonly onView: (view: View) => void;
  /** The left edge of a panel that floats over the map, or null; live previews skip cards under it. */
  readonly panelLeft: number | null;
  /** The right edge of the shelf (K-525), or 0 without one; live previews skip cards under it too. */
  readonly trayRight: number;
  /** K-1508: `itemKey`s of the cards and circles that a History row highlights now. */
  readonly flash: ReadonlySet<string>;
  readonly openStacks: ReadonlySet<string>;
  readonly onToggleStack: (key: string) => void;
  readonly onCommit: (edits: Array<Edit>, diffs: Array<ShareDiff>) => void;
  /** K-522: cards dropped on another card become one stack with it. */
  readonly onStackOnto: (ids: Array<string>, target: string) => void;
  /** K-523: opens the context menu of a target next to `anchor`, or closes it with null. */
  readonly onMenu: (menu: { readonly target: MenuTarget; readonly anchor: Rect } | null) => void;
}

/** K-504: the circle-alone key of this device. */
export const ALONE_KEY = circleAloneKey(navigator.platform);

/** Preact 11 does not add a unit to numeric style values. */
const px = (value: number) => `${value}px`;
/** An open stack spaces its cards by this much: the card width (styles.css) plus a gap. */
const STACK_GAP = 205;
/** The row step of an open owner's stack. */
const STACK_ROW = 100;

/** Live previews: at most this many frames, for these kinds, from this zoom on. */
const MAX_PREVIEWS = 4;
const PREVIEW_SCALE = 0.8;

/** The drag data of tray cards: a JSON list of card ids. */
export const TRAY_CARDS_TYPE = "application/x-kitshn-cards";
const ZOOMED_OUT = 0.4;

export function MapView(props: Props) {
  const { state, view } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  /** The fingers on the map now, by pointer id, for a pinch. */
  const fingers = useRef(new Map<number, Point>());
  const twoFingers = (): Fingers | null => {
    const [a, b] = [...fingers.current.values()];
    return a && b ? { a, b } : null;
  };
  /** A touch on a card that selects it on release, unless it moved, held or became a pinch. */
  const tap = useRef<{ readonly choose: () => void; readonly stack: string | null } | null>(null);
  const [stackTarget, setStackTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ state: State; diffs: Array<ShareDiff>; pointer: Point } | null>(null);
  /** K-523: a right press or a touch that may open the context menu. */
  const hold = useRef<{ press: Press; readonly target: MenuTarget; timer: number | null } | null>(null);
  /**
   * A right release that the browser's `contextmenu` follows (Windows): that event opens the menu, unless the
   * press panned. On macOS and Linux `contextmenu` comes with the press instead, while `hold` is set.
   */
  const rightRelease = useRef<{ readonly panned: boolean } | null>(null);
  useEffect(() => {
    // A press anywhere else, or leaving the window, ends a right release that no `contextmenu` followed.
    const forget = () => {
      rightRelease.current = null;
    };
    addEventListener("pointerdown", forget, true);
    addEventListener("blur", forget);
    return () => {
      removeEventListener("pointerdown", forget, true);
      removeEventListener("blur", forget);
    };
  }, []);
  const viewport = useRef<HTMLDivElement>(null);
  /** The cards that had a frame in the last render (live previews keep them, see below). */
  const previewed = useRef<ReadonlySet<string>>(new Set());

  const shown = draft?.state ?? state;
  // A head slides along its circle off the cards (layout.ts). It follows the stored map, not a drag in flight,
  // so a head never jumps while a card passes it.
  const headAngles = useMemo(() => {
    const cards = shownCardBoxes(state, props.hidden);
    return new Map([...state.circles.values()].map((circle) => [circle.id, headAngle(circle, cards)]));
  }, [state, props.hidden]);
  const toWorld = (clientX: number, clientY: number): Point => ({
    x: (clientX - view.x) / view.s,
    y: (clientY - view.y) / view.s,
  });
  const stacks = stacksOf(shown);
  const stackOf = (id: string) => [...stacks.entries()].find(([, ids]) => ids.includes(id));

  /** The drawn card under the pointer that a drop stacks onto, from what is on screen (K-522). */
  const stackTargetAt = (clientX: number, clientY: number, dragged: ReadonlySet<string>) => {
    const top = document
      .elementsFromPoint(clientX, clientY)
      .find((element) => !dragged.has(element.closest<HTMLElement>("[data-card]")?.dataset["card"] ?? ""));
    const id = top?.closest<HTMLElement>("[data-card]")?.dataset["card"];
    if (!id) return null;
    // A stack by group (K-508) keeps its cards; a drop there moves instead.
    const stack = stackOf(id);
    return stack && !stack[0].startsWith(USER_STACK) ? null : id;
  };

  const preview = (changes: Array<Change>, pointer: Point) => {
    const next = applyChanges(state, changes);
    setDraft({ state: next, diffs: shareDiff(state, next), pointer });
  };

  /** K-523: what a context menu at this element and map point is for. */
  const targetAt = (element: Element | null, at: Point): MenuTarget => {
    const head = element?.closest<HTMLElement>("[data-head]")?.dataset["head"];
    if (head) return { _tag: "circle", id: head };
    const card = element?.closest<HTMLElement>("[data-card]")?.dataset["card"];
    if (!card) return { _tag: "map", at };
    // A closed stack of the owner draws as one card, so its menu is the stack's.
    const stack = stackOf(card);
    return stack && stack[0].startsWith(USER_STACK) && !props.openStacks.has(stack[0])
      ? { _tag: "stack", id: stack[0].slice(USER_STACK.length) }
      : { _tag: "card", id: card };
  };
  const openMenu = (target: MenuTarget, at: Point) =>
    props.onMenu({ target, anchor: { left: at.x, top: at.y, width: 0, height: 0 } });

  /** A right press opens the menu on release; a touch opens it after `HOLD_MS` and then `then` runs. */
  const beginPress = (event: PointerEvent, then?: () => void) => {
    // A second finger ends the first press, so its timer never opens a menu after it lifts.
    endPress();
    const start = { x: event.clientX, y: event.clientY };
    const entry = {
      press: startPress(start),
      target: targetAt(event.target as Element, toWorld(event.clientX, event.clientY)),
      timer: null as number | null,
    };
    if (event.pointerType === "touch")
      entry.timer = window.setTimeout(() => {
        entry.timer = null;
        entry.press = stepPress(entry.press, { type: "elapsed" });
        then?.();
        openMenu(entry.target, start);
      }, HOLD_MS);
    hold.current = entry;
  };

  const endPress = () => {
    const entry = hold.current;
    hold.current = null;
    if (entry?.timer != null) window.clearTimeout(entry.timer);
    return entry;
  };

  const placeChanges = (moves: Iterable<[string, Point]>): Array<Change> =>
    [...moves].map(([id, after]) => ({ _tag: "place", id, before: state.places.get(id) ?? null, after }));

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    const world = toWorld(event.clientX, event.clientY);
    // A new press ends an older one, also a touch whose release never came.
    endPress();
    try {
      // Every pointer, also each finger of a pinch, so its release always reaches the map.
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is gone cannot be captured; the drag still works inside the viewport.
    }
    if (event.pointerType === "touch") {
      // A second finger turns any one-finger gesture into a pinch; a card drag in progress drops nothing, and
      // the card under the first finger is not selected.
      const both = fingerDown(
        fingers.current,
        event.pointerId,
        { x: event.clientX, y: event.clientY },
        event.isPrimary,
      );
      if (both) {
        tap.current = null;
        props.onMenu(null);
        setStackTarget(null);
        setDraft(null);
        setDrag({ type: "pinch", from: both, view });
        return;
      }
    }
    if (event.button === 1 || event.button === 2) {
      if (event.button === 2) beginPress(event);
      setDrag({ type: "pan", sx: event.clientX, sy: event.clientY, view });
      return;
    }
    if (event.pointerType === "touch" && !target.closest("[data-card]")) beginPress(event);
    const grip = target.closest<HTMLElement>("[data-grip]");
    const head = target.closest<HTMLElement>("[data-head]");
    const cardElement = target.closest<HTMLElement>("[data-card]");
    if (grip) {
      const origin = state.circles.get(grip.dataset["grip"] ?? "");
      if (origin) setDrag({ type: "resize", origin });
      return;
    }
    if (head) {
      const origin = state.circles.get(head.dataset["head"] ?? "");
      if (!origin) return;
      props.onSelect({ cards: new Set(), circle: origin.id });
      // K-504: the head carries the cards inside the circle; the modifier moves the circle alone.
      const carry = new Map<string, Point>();
      if (!event[ALONE_KEY.property]) {
        for (const [id, place] of state.places) if (insideCircle(place, origin)) carry.set(id, place);
      }
      setDrag({ type: "circle", start: world, origin, carry, moved: false });
      return;
    }
    if (cardElement) {
      const id = cardElement.dataset["card"] ?? "";
      if (event.shiftKey) {
        const cards = new Set(props.selection.cards);
        if (cards.has(id)) cards.delete(id);
        else cards.add(id);
        props.onSelect({ cards, circle: null });
        return;
      }
      const ids = new Set(props.selection.cards.has(id) ? props.selection.cards : [id]);
      const stack = stackOf(id);
      if (stack && !props.openStacks.has(stack[0])) for (const member of stack[1]) ids.add(member);
      // K-521: an owner's stack moves as one, also when it is open; Pull out takes a card out.
      for (const card of ids) {
        const own = stackOf(card);
        if (own?.[0].startsWith(USER_STACK)) for (const member of own[1]) ids.add(member);
      }
      // A closed stack of the owner is selected whole, so its panel shows (K-521).
      const whole = stack && !props.openStacks.has(stack[0]) && stack[0].startsWith(USER_STACK);
      const choose = () => {
        if (!props.selection.cards.has(id))
          props.onSelect({ cards: whole ? new Set(ids) : new Set([id]), circle: null });
      };
      const origins = new Map<string, Point>();
      for (const card of ids) origins.set(card, state.places.get(card) ?? world);
      const under = stackTargetAt(event.clientX, event.clientY, ids);
      const start = () => {
        choose();
        setDrag({ type: "cards", start: world, origins, clicked: id, under, moved: false });
      };
      // K-516, K-523: on touch, a long press opens the menu and starts the drag, so a swipe still pans; a tap
      // selects on release, so a pinch that starts on a card does not select it.
      if (event.pointerType === "touch") {
        setDrag({ type: "pan", sx: event.clientX, sy: event.clientY, view });
        tap.current = { choose, stack: stack?.[0] ?? null };
        beginPress(event, start);
      } else start();
      return;
    }
    if (event.pointerType === "touch") {
      setDrag({ type: "pan", sx: event.clientX, sy: event.clientY, view });
      return;
    }
    const base = event.shiftKey ? props.selection.cards : new Set<string>();
    props.onSelect({ cards: base, circle: null });
    setDrag({ type: "box", start: world, end: world, base });
  };

  const onPointerMove = (event: PointerEvent) => {
    const pointer = { x: event.clientX, y: event.clientY };
    if (fingers.current.has(event.pointerId)) fingers.current.set(event.pointerId, pointer);
    if (drag?.type === "pinch") {
      const both = twoFingers();
      if (both) props.onView(pinchView(drag.view, drag.from, both));
      return;
    }
    const entry = hold.current;
    if (entry) {
      const was = entry.press.phase;
      entry.press = stepPress(entry.press, { type: "move", at: pointer });
      // A move before the hold is a pan; a move after it is a drag, which closes the menu.
      if (entry.press.phase === "moved" && was !== "moved") {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
        entry.timer = null;
        if (was === "held") props.onMenu(null);
      }
    }
    if (!drag) return;
    const world = toWorld(event.clientX, event.clientY);
    if (drag.type === "pan") {
      props.onView({
        ...drag.view,
        x: drag.view.x + event.clientX - drag.sx,
        y: drag.view.y + event.clientY - drag.sy,
      });
      return;
    }
    if (drag.type === "box") {
      const box = { ...drag, end: world };
      setDrag(box);
      const [x1, x2] = [Math.min(box.start.x, world.x), Math.max(box.start.x, world.x)];
      const [y1, y2] = [Math.min(box.start.y, world.y), Math.max(box.start.y, world.y)];
      const cards = new Set(drag.base);
      for (const [id, place] of state.places) {
        const kind = state.resources.get(id)?.kind;
        if (kind && !props.hidden.has(kind) && place.x > x1 && place.x < x2 && place.y > y1 && place.y < y2) {
          cards.add(id);
        }
      }
      props.onSelect({ cards, circle: null });
      return;
    }
    if (drag.type === "cards") {
      const dx = world.x - drag.start.x;
      const dy = world.y - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4 / view.s) drag.moved = true;
      if (!drag.moved) return;
      const moves = [...drag.origins].map(([id, origin]): [string, Point] => [
        id,
        { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) },
      ]);
      preview(placeChanges(moves), pointer);
      const target = stackTargetAt(event.clientX, event.clientY, new Set(drag.origins.keys()));
      // Once the pointer leaves the card it was grabbed over, that card is a target like any other.
      if (target !== drag.under) drag.under = null;
      setStackTarget(target === drag.under ? null : target);
      return;
    }
    if (drag.type === "circle") {
      const dx = world.x - drag.start.x;
      const dy = world.y - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4 / view.s) drag.moved = true;
      if (!drag.moved) return;
      const after = { ...drag.origin, x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) };
      const moves = [...drag.carry].map(([id, origin]): [string, Point] => [
        id,
        { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) },
      ]);
      preview(
        [{ _tag: "circle", id: after.id, before: drag.origin, after }, ...placeChanges(moves)],
        pointer,
      );
      return;
    }
    const r = Math.max(60, Math.round(Math.hypot(world.x - drag.origin.x, world.y - drag.origin.y) * 1.2));
    preview(
      [{ _tag: "circle", id: drag.origin.id, before: drag.origin, after: { ...drag.origin, r } }],
      pointer,
    );
  };

  const onPointerUp = (event: PointerEvent) => {
    fingers.current.delete(event.pointerId);
    // The pinch ends with the first finger that lifts; the other one starts nothing until it lifts too.
    if (drag?.type === "pinch") {
      endPress();
      setDrag(null);
      return;
    }
    const pending = tap.current;
    tap.current = null;
    const press = endPress();
    // A touch on a card that neither moved nor held is a tap: it selects, and opens a stack as a click does.
    if (pending && press?.press.phase === "waiting") {
      pending.choose();
      if (pending.stack) props.onToggleStack(pending.stack);
    }
    // No `contextmenu` came during the press, so it follows the release; a press that opened the menu is done.
    if (event.button === 2 && press && press.press.phase !== "held")
      rightRelease.current = { panned: press.press.phase === "moved" };
    // A touch that opened the menu does not also open a stack.
    const held = press?.press.phase === "held";
    // K-522: cards let go over another card stack with it instead of moving.
    if (drag?.type === "cards" && drag.moved) {
      const dragged = new Set(drag.origins.keys());
      const found = stackTargetAt(event.clientX, event.clientY, dragged);
      const target = found === drag.under ? null : found;
      setStackTarget(null);
      if (target) {
        props.onStackOnto([...dragged], target);
        setDrag(null);
        setDraft(null);
        return;
      }
    }
    if (drag?.type === "cards" && !drag.moved && !held) {
      const stack = stackOf(drag.clicked);
      if (stack) props.onToggleStack(stack[0]);
    }
    if (draft) {
      const edits = editsOf(state, draft.state);
      if (edits.length > 0) props.onCommit(edits, draft.diffs);
    }
    setDrag(null);
    setDraft(null);
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const world = toWorld(event.clientX, event.clientY);
      const s = Math.min(ZOOM.max, Math.max(ZOOM.min, view.s * Math.exp(-event.deltaY / 300)));
      props.onView({ x: event.clientX - world.x * s, y: event.clientY - world.y * s, s });
    } else props.onView({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
  };

  const previewCircles = new Set(draft?.diffs.map((diff) => diff.circle.id));
  // A few frames at most, for the site cards nearest the centre of the view, and only when they are readable.
  // Candidates: drawn site and page cards whose centre is in the open part of the map (not under the tray
  // or the panel). A card keeps its frame while it stays a candidate, so a pan never reloads a frame.
  const visible =
    props.previews && view.s >= PREVIEW_SCALE
      ? [...shown.places]
          .filter(([id]) => {
            const kind = shown.resources.get(id)?.kind;
            const stack = stackOf(id);
            // A closed owner's stack draws a list, not a frame.
            const drawn =
              !stack ||
              props.openStacks.has(stack[0]) ||
              (stack[1][0] === id && !stack[0].startsWith(USER_STACK));
            return kind !== undefined && FRAMED_KINDS.has(kind) && !props.hidden.has(kind) && drawn;
          })
          .map(([id, place]) => ({ id, x: place.x * view.s + view.x, y: place.y * view.s + view.y }))
          .filter(
            (card) =>
              card.x > props.trayRight &&
              card.y > 120 &&
              card.x < (props.panelLeft ?? innerWidth) &&
              card.y < innerHeight,
          )
          .sort(
            (a, b) =>
              Math.hypot(a.x - innerWidth / 2, a.y - innerHeight / 2) -
              Math.hypot(b.x - innerWidth / 2, b.y - innerHeight / 2),
          )
          .map((card) => card.id)
      : [];
  const kept = [...previewed.current].filter((id) => visible.includes(id));
  const previewIds = new Set([...kept, ...visible.filter((id) => !kept.includes(id))].slice(0, MAX_PREVIEWS));
  previewed.current = previewIds;
  const zoomedOut = view.s < ZOOMED_OUT;
  const draggedIds = drag?.type === "cards" && drag.moved ? new Set(drag.origins.keys()) : new Set<string>();

  return (
    <div
      class="viewport"
      ref={viewport}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={(event) => {
        // A finger that the page lost ends a pinch, so it never turns a later touch into one.
        fingers.current.delete(event.pointerId);
        if (drag?.type === "pinch") setDrag(null);
      }}
      onPointerCancel={(event) => {
        // A cancelled pointer drops nothing; the cards go back.
        tap.current = null;
        fingers.current.delete(event.pointerId);
        endPress();
        rightRelease.current = null;
        setStackTarget(null);
        setDrag(null);
        setDraft(null);
      }}
      onWheel={onWheel}
      onContextMenu={(event) => {
        event.preventDefault();
        const press = hold.current;
        if (press) {
          // A touch opens its menu after HOLD_MS. A right press on macOS opens it now, unless it panned;
          // a move after this closes it, as after a long press.
          if (press.timer === null && press.press.phase === "waiting") {
            press.press = stepPress(press.press, { type: "elapsed" });
            openMenu(press.target, press.press.start);
          }
          return;
        }
        const release = rightRelease.current;
        rightRelease.current = null;
        if (release?.panned) return;
        // A right release, Ctrl and a click on macOS, the menu key or Shift+F10: the clicked or focused item.
        const element = event.target as HTMLElement;
        const box = element.getBoundingClientRect();
        const at =
          event.clientX || event.clientY
            ? { x: event.clientX, y: event.clientY }
            : { x: box.left, y: box.bottom };
        setDrag(null);
        setDraft(null);
        props.onMenu({
          target: targetAt(element, toWorld(at.x, at.y)),
          anchor: event.clientX || event.clientY ? { left: at.x, top: at.y, width: 0, height: 0 } : box,
        });
      }}
      onDragOver={(event) => {
        const types = event.dataTransfer?.types ?? [];
        if (!types.includes("Files") && !types.includes(TRAY_CARDS_TYPE)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "move";
      }}
      onDrop={(event) => {
        const at = toWorld(event.clientX, event.clientY);
        const cards = event.dataTransfer?.getData(TRAY_CARDS_TYPE);
        if (cards) {
          event.preventDefault();
          props.onDropCards(JSON.parse(cards) as Array<string>, at);
          return;
        }
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length === 0) return;
        event.preventDefault();
        props.onDropFiles(files, at);
      }}
    >
      <div class="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
        {[...shown.circles.values()].map((circle) => (
          <CircleView
            key={circle.id}
            circle={circle}
            state={shown}
            selected={props.selection.circle === circle.id}
            preview={previewCircles.has(circle.id)}
            flash={props.flash.has(`circle:${circle.id}`)}
            headAngle={headAngles.get(circle.id) ?? 0}
            zoomedOut={zoomedOut}
            hidden={props.hidden}
            onMenu={(anchor) => props.onMenu({ target: { _tag: "circle", id: circle.id }, anchor })}
          />
        ))}
        {[...shown.resources.values()].map((resource) => {
          const place = shown.places.get(resource.id);
          if (!place || props.hidden.has(resource.kind)) return null;
          const stack = stackOf(resource.id);
          const open = stack ? props.openStacks.has(stack[0]) : false;
          const index = stack ? stack[1].indexOf(resource.id) : 0;
          const own = stack?.[0].startsWith(USER_STACK) ?? false;
          // A closed owner's stack shows through its first card of a shown kind.
          const face = own
            ? stack?.[1].find((id) => !props.hidden.has(shown.resources.get(id)?.kind ?? resource.kind))
            : stack?.[1][0];
          if (stack && !open && resource.id !== face) return null;
          const head = stack ? shown.places.get(stack[1][0] ?? "") : undefined;
          // An owner's stack opens downwards, as a list; a stack by group opens in a row (K-508, K-521).
          const at =
            stack && open && head
              ? own
                ? { x: head.x, y: head.y + index * STACK_ROW }
                : { x: head.x + index * STACK_GAP, y: head.y }
              : place;
          const selected = props.selection.cards.has(resource.id);
          // A closed stack shows the highlight of any of its cards.
          const flash = (stack && !open ? stack[1] : [resource.id]).some((id) =>
            props.flash.has(`card:${id}`),
          );
          if (zoomedOut) {
            return (
              <div
                key={resource.id}
                data-card={resource.id}
                class={`mini${selected ? " sel" : ""}${stackTarget === resource.id ? " stack-target" : ""}${flash ? " flash" : ""}`}
                style={{ left: px(at.x), top: px(at.y), background: KINDS[resource.kind].color }}
                tabIndex={0}
                role="img"
                aria-label={resource.name}
                data-tip={`${resource.name}: ${KINDS[resource.kind].help} Zoom in to see its card.`}
              />
            );
          }
          if (stack && own && !open) {
            const userStack = shown.stacks.get(stack[0].slice(USER_STACK.length));
            return (
              <StackCard
                key={resource.id}
                id={resource.id}
                name={userStack?.name ?? "Stack"}
                members={stack[1].flatMap((id) => shown.resources.get(id) ?? [])}
                state={shown}
                at={at}
                selected={stack[1].some((id) => props.selection.cards.has(id))}
                dragging={draggedIds.has(resource.id)}
                target={stackTarget === resource.id}
                flash={flash}
                onMenu={(anchor) =>
                  props.onMenu({ target: { _tag: "stack", id: stack[0].slice(USER_STACK.length) }, anchor })
                }
              />
            );
          }
          return (
            <CardView
              key={resource.id}
              resource={resource}
              state={shown}
              at={at}
              selected={selected}
              dragging={draggedIds.has(resource.id)}
              target={stackTarget === resource.id}
              flash={flash}
              count={stack && index === 0 ? stack[1].length : null}
              open={open}
              access={props.access[resource.id] ?? null}
              machine={props.machines.get(resource.id) ?? null}
              preview={previewIds.has(resource.id)}
              peek={props.peek && props.selection.cards.size === 1}
              zone={props.zone}
              onMenu={(anchor) => props.onMenu({ target: { _tag: "card", id: resource.id }, anchor })}
            />
          );
        })}
      </div>
      {drag?.type === "box" ? (
        <div
          class="box"
          style={{
            left: px(Math.min(drag.start.x, drag.end.x) * view.s + view.x),
            top: px(Math.min(drag.start.y, drag.end.y) * view.s + view.y),
            width: px(Math.abs(drag.end.x - drag.start.x) * view.s),
            height: px(Math.abs(drag.end.y - drag.start.y) * view.s),
          }}
        />
      ) : null}
      {draft && stackTarget ? (
        <div class="drop-label" style={{ left: px(draft.pointer.x), top: px(draft.pointer.y) }}>
          <span>
            Stack with{" "}
            {[...state.stacks.values()].find((stack) => stack.members.includes(stackTarget))?.name ??
              state.resources.get(stackTarget)?.name ??
              "this card"}
          </span>
        </div>
      ) : draft && draft.diffs.length > 0 ? (
        <div class="drop-label" style={{ left: px(draft.pointer.x), top: px(draft.pointer.y) }}>
          {draft.diffs.slice(0, 6).map((diff) => (
            <span key={`${diff.resource.id}/${diff.circle.id}`} class={diff.to ? "" : "minus"}>
              {diff.to ? `+ ${diff.circle.name} · ${diff.to}` : `− ${diff.circle.name}`}
              {draft.diffs.some((other) => other.resource.id !== diff.resource.id)
                ? ` (${diff.resource.name})`
                : ""}
            </span>
          ))}
          {draft.diffs.length > 6 ? <span>and {draft.diffs.length - 6} more</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The edits that turn `from` into `to`, for circles and places only. */
function editsOf(from: State, to: State): Array<Edit> {
  const edits: Array<Edit> = [];
  for (const [id, circle] of to.circles)
    if (from.circles.get(id) !== circle) edits.push({ _tag: "circle", id, after: circle });
  for (const [id, place] of to.places)
    if (from.places.get(id) !== place) edits.push({ _tag: "place", id, after: place });
  return edits;
}

function CircleView(props: {
  circle: Circle;
  state: State;
  selected: boolean;
  preview: boolean;
  flash: boolean;
  /** Where the head sits on the edge, in radians from the top (layout.ts). */
  headAngle: number;
  zoomedOut: boolean;
  hidden: ReadonlySet<ResourceKind>;
  onMenu: (anchor: Rect) => void;
}) {
  const { circle } = props;
  const shown = circle.members.slice(0, 4);
  // K-718: rights count only in a circle of devices only.
  const agentCircle = circle.members.every((member) => member._tag === "device");
  const extra = circle.members.length - shown.length;
  const counts = new Map<ResourceKind, number>();
  if (props.zoomedOut) {
    for (const resource of props.state.resources.values()) {
      const place = props.state.places.get(resource.id);
      if (place && insideCircle(place, circle))
        counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
    }
  }
  return (
    <div
      class={`circle${props.selected ? " sel" : ""}${props.preview ? " preview" : ""}${props.flash ? " flash" : ""}`}
      style={{
        left: px(circle.x - circle.r),
        top: px(circle.y - circle.r),
        width: px(circle.r * 2),
        height: px(circle.r * 2),
        "--c": circle.color,
      }}
    >
      <div
        class="head"
        data-head={circle.id}
        style={{
          left: px(circle.r + circle.r * Math.sin(props.headAngle)),
          top: px(circle.r - circle.r * Math.cos(props.headAngle) - 20),
        }}
        tabIndex={0}
        role="group"
        aria-label={`Circle ${circle.name}`}
        data-tip={`${circle.name}: a click edits the circle. A drag moves it with its cards; ${ALONE_KEY.label} and a drag moves the circle alone.`}
      >
        <span>{circle.name}</span>
        <span
          class="sticker"
          data-tip={LEVEL_TIPS[circle.level]}
          style={{ "--tilt": LEVEL_TILTS[circle.level], background: LEVEL_COLORS[circle.level] }}
        >
          {circle.level}
        </span>
        {circle.needsPasskey ? (
          <span role="img" aria-label="Needs a passkey" data-tip={PASSKEY_TIP}>
            🔑
          </span>
        ) : null}
        {circle.match === "all" ? (
          <span role="img" aria-label="All must match" data-tip={MATCH_TIPS.all}>
            ∧
          </span>
        ) : null}
        <MoreButton name={circle.name} onOpen={props.onMenu} />
      </div>
      {props.zoomedOut ? (
        <div class="counts">
          {[...counts].map(([kind, count]) => (
            <span
              key={kind}
              data-tip={`${count} ${KINDS[kind].label.toLowerCase()} in ${circle.name}. Zoom in to see the cards.`}
            >
              {KINDS[kind].icon} {count}
            </span>
          ))}
        </div>
      ) : (
        <div class="members">
          {shown.map((member, index) => (
            <span class="chip" key={index} data-tip={MEMBER_HELP[member._tag]}>
              {MEMBER_ICONS[member._tag]} {memberLabel(member)}
              {member._tag === "device" && isAgentKey(props.state, member, Date.now()) ? (
                <>
                  <span class="sticker agent" data-tip={AGENT_TIP}>
                    agent
                  </span>
                  {agentCircle ? <RightStickers member={member} /> : null}
                </>
              ) : null}
            </span>
          ))}
          {extra > 0 ? (
            <span
              class="chip"
              data-head={circle.id}
              data-tip={`Also ${circle.members.slice(4).map(memberLabel).join(", ")}. A click opens the full list.`}
            >
              +{extra}
            </span>
          ) : null}
        </div>
      )}
      <div
        class="grip"
        data-grip={circle.id}
        data-tip="Drag to resize the circle. The preview names every card that gains or loses it."
      />
    </div>
  );
}

function CardView(props: {
  resource: Resource;
  state: State;
  at: Point;
  selected: boolean;
  dragging: boolean;
  target: boolean;
  flash: boolean;
  count: number | null;
  open: boolean;
  access: AccessState | null;
  machine: MachineView | null;
  preview: boolean;
  /** K-520: the selected card offers the preview arrow; a phone has it in the card sheet instead. */
  peek: boolean;
  zone: string;
  onMenu: (anchor: Rect) => void;
}) {
  const { resource, state } = props;
  const kind = KINDS[resource.kind];
  const holding = circlesHolding(state, resource.id);
  return (
    <div
      class={`card${props.selected ? " sel" : ""}${props.dragging ? " dragging" : ""}${props.target ? " stack-target" : ""}${props.flash ? " flash" : ""}`}
      data-card={resource.id}
      style={{ left: px(props.at.x), top: px(props.at.y) }}
    >
      {props.count !== null ? (
        <span
          class="sticker count"
          data-tip={`${props.count} cards of one group. A click ${props.open ? "closes" : "spreads"} them; a drag moves them all.`}
        >
          {props.count}
          {props.open ? " ▾" : ""}
        </span>
      ) : null}
      {props.access?.state === "applying" ? (
        <span class="sticker wait state" data-tip={ACCESS_TIPS.applying}>
          applying
        </span>
      ) : null}
      {props.access?.state === "failed" ? (
        <span class="sticker state" data-tip={`Failed: Cloudflare refused the change. ${props.access.error}`}>
          failed
        </span>
      ) : null}
      <div class="name">
        <ItemIcon resource={resource} />
        {resource.name}
      </div>
      <div class="sub">{resource.addresses[0] ?? resource.kind}</div>
      <div class="foot">
        <span
          class="sticker"
          data-tip={kind.help}
          style={{ "--tilt": kind.tilt, background: kind.color, color: kind.ink }}
        >
          {resource.kind}
        </span>
        {props.machine ? <PresenceSticker view={props.machine} /> : null}
        {props.machine ? <KeySticker view={props.machine} /> : null}
        {holding.map((circle) => {
          const level = shareLevel(state, resource, circle);
          return (
            <span
              key={circle.id}
              class="dot"
              tabIndex={0}
              role="img"
              aria-label={`${circle.name} · ${level ?? "none"}`}
              data-tip={`${circle.name} · ${level ?? "none"}: shared with this circle at ${level ?? "no level"}.`}
              style={{ background: circle.color }}
            />
          );
        })}
        {holding
          .filter((circle) => state.shareSettings.get(shareKey(resource.id, circle.id))?.level)
          .map((circle) => (
            <span
              key={`o-${circle.id}`}
              class="chip"
              data-tip={`Level override: this card has its own level in ${circle.name}, not the circle's default.`}
            >
              {circle.name}: {shareLevel(state, resource, circle) ?? "none"}
            </span>
          ))}
        <MoreButton name={resource.name} onOpen={props.onMenu} />
      </div>
      {props.preview && resource.addresses[0] ? (
        <CardPreview resource={resource} state={state} zone={props.zone} />
      ) : props.selected && props.peek && peekable(resource) ? (
        <PeekArrow resource={resource} state={state} zone={props.zone} />
      ) : null}
    </div>
  );
}

/** K-521: a closed stack of the owner, as one card that lists its cards. A click opens it. */
function StackCard(props: {
  id: string;
  name: string;
  members: ReadonlyArray<Resource>;
  state: State;
  at: Point;
  selected: boolean;
  dragging: boolean;
  target: boolean;
  flash: boolean;
  onMenu: (anchor: Rect) => void;
}) {
  const holding = circlesHolding(props.state, props.id);
  return (
    <div
      class={`card stack-card${props.selected ? " sel" : ""}${props.dragging ? " dragging" : ""}${props.target ? " stack-target" : ""}${props.flash ? " flash" : ""}`}
      data-card={props.id}
      style={{ left: px(props.at.x), top: px(props.at.y) }}
    >
      <span
        class="sticker count"
        data-tip={`${props.members.length} cards in this stack. A click opens it as a column.`}
      >
        {props.members.length} ▸
      </span>
      <div class="name">🗃 {props.name}</div>
      <ul>
        {props.members.slice(0, 6).map((member) => (
          <li key={member.id}>
            <ItemIcon resource={member} />
            {member.name}
          </li>
        ))}
        {props.members.length > 6 ? <li class="muted">and {props.members.length - 6} more</li> : null}
      </ul>
      <div class="foot">
        {holding.map((circle) => (
          <span
            key={circle.id}
            class="dot"
            tabIndex={0}
            role="img"
            aria-label={circle.name}
            data-tip={`${circle.name}: every card of this stack is shared with this circle.`}
            style={{ background: circle.color }}
          />
        ))}
        <MoreButton name={props.name} onOpen={props.onMenu} />
      </div>
    </div>
  );
}
