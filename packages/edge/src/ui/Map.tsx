import { useRef, useState } from "preact/hooks";
import { type Change, type Edit, type ShareDiff, applyChanges, shareDiff } from "../core/changes.ts";
import {
  type Circle,
  type Point,
  type Resource,
  type ResourceKind,
  type State,
  circlesHolding,
  insideCircle,
  memberLabel,
  shareKey,
  shareLevel,
} from "../core/model.ts";
import type { AccessState, MachineView } from "../core/protocol.ts";
import { KINDS, LEVEL_COLORS, LEVEL_TILTS, MEMBER_ICONS } from "./kinds.ts";
import { PresenceSticker } from "./Machines.tsx";

export interface View {
  readonly x: number;
  readonly y: number;
  readonly s: number;
}

export type Selection = { readonly cards: ReadonlySet<string>; readonly circle: string | null };

type Drag =
  | { readonly type: "pan"; readonly sx: number; readonly sy: number; readonly view: View }
  | {
      readonly type: "cards";
      readonly start: Point;
      readonly origins: ReadonlyMap<string, Point>;
      readonly clicked: string;
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
  readonly onView: (view: View) => void;
  readonly openStacks: ReadonlySet<string>;
  readonly onToggleStack: (key: string) => void;
  readonly onCommit: (edits: Array<Edit>, diffs: Array<ShareDiff>) => void;
  /** K-522: cards dropped on another card become one stack with it. */
  readonly onStackOnto: (ids: Array<string>, target: string) => void;
}

const LONG_PRESS_MS = 350;
/** Preact 11 does not add a unit to numeric style values. */
const px = (value: number) => `${value}px`;
/** An open stack spaces its cards by this much: the card width (styles.css) plus a gap. */
const STACK_GAP = 205;
/** The half size of a card (styles.css), to find the card under a drop; and the row step of an open stack. */
const CARD_HALF_WIDTH = 95;
const CARD_HALF_HEIGHT = 40;
const STACK_ROW = 100;

/** Live previews: at most this many frames, for these kinds, from this zoom on. */
const MAX_PREVIEWS = 4;
const PREVIEW_SCALE = 0.8;
const PREVIEW_KINDS: ReadonlySet<ResourceKind> = new Set([
  "site.static",
  "site.worker",
  "site.compose",
  "site.live",
  "page",
]);

/** The drag data of tray cards: a JSON list of card ids. */
export const TRAY_CARDS_TYPE = "application/x-kitshn-cards";
const ZOOMED_OUT = 0.4;

export function MapView(props: Props) {
  const { state, view } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<{ state: State; diffs: Array<ShareDiff>; pointer: Point } | null>(null);
  const longPress = useRef<number | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  /** The cards that had a frame in the last render (live previews keep them, see below). */
  const previewed = useRef<ReadonlySet<string>>(new Set());

  const shown = draft?.state ?? state;
  const toWorld = (clientX: number, clientY: number): Point => ({
    x: (clientX - view.x) / view.s,
    y: (clientY - view.y) / view.s,
  });
  const stacks = stacksOf(shown);
  const stackOf = (id: string) => [...stacks.entries()].find(([, ids]) => ids.includes(id));

  const preview = (changes: Array<Change>, pointer: Point) => {
    const next = applyChanges(state, changes);
    setDraft({ state: next, diffs: shareDiff(state, next), pointer });
  };

  const placeChanges = (moves: Iterable<[string, Point]>): Array<Change> =>
    [...moves].map(([id, after]) => ({ _tag: "place", id, before: state.places.get(id) ?? null, after }));

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    const world = toWorld(event.clientX, event.clientY);
    if (event.button === 1 || event.button === 2) {
      setDrag({ type: "pan", sx: event.clientX, sy: event.clientY, view });
      return;
    }
    const grip = target.closest<HTMLElement>("[data-grip]");
    const head = target.closest<HTMLElement>("[data-head]");
    const cardElement = target.closest<HTMLElement>("[data-card]");
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is gone cannot be captured; the drag still works inside the viewport.
    }
    if (grip) {
      const origin = state.circles.get(grip.dataset["grip"] ?? "");
      if (origin) setDrag({ type: "resize", origin });
      return;
    }
    if (head) {
      const origin = state.circles.get(head.dataset["head"] ?? "");
      if (!origin) return;
      props.onSelect({ cards: new Set(), circle: origin.id });
      // K-504: the head carries the cards inside the circle; Alt moves the circle alone.
      const carry = new Map<string, Point>();
      if (!event.altKey) {
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
      // A closed stack of the owner is selected whole, so its panel shows (K-521).
      const whole = stack && !props.openStacks.has(stack[0]) && stack[0].startsWith(USER_STACK);
      if (!props.selection.cards.has(id))
        props.onSelect({ cards: whole ? new Set(ids) : new Set([id]), circle: null });
      const origins = new Map<string, Point>();
      for (const card of ids) origins.set(card, state.places.get(card) ?? world);
      const start = () => setDrag({ type: "cards", start: world, origins, clicked: id, moved: false });
      // K-516: on touch, a long press starts the drag, so a swipe still pans.
      if (event.pointerType === "touch") {
        setDrag({ type: "pan", sx: event.clientX, sy: event.clientY, view });
        longPress.current = window.setTimeout(start, LONG_PRESS_MS);
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
    if (!drag) return;
    const world = toWorld(event.clientX, event.clientY);
    const pointer = { x: event.clientX, y: event.clientY };
    if (drag.type === "pan") {
      if (longPress.current !== null && Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) > 8) {
        window.clearTimeout(longPress.current);
        longPress.current = null;
      }
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
    if (longPress.current !== null) {
      window.clearTimeout(longPress.current);
      longPress.current = null;
    }
    // K-522: cards let go over another card stack with it instead of moving.
    if (drag?.type === "cards" && drag.moved) {
      const at = toWorld(event.clientX, event.clientY);
      const dragged = new Set(drag.origins.keys());
      const target = [...state.places].find(
        ([id, place]) =>
          !dragged.has(id) &&
          Math.abs(place.x - at.x) < CARD_HALF_WIDTH &&
          Math.abs(place.y - at.y) < CARD_HALF_HEIGHT,
      )?.[0];
      if (target) {
        props.onStackOnto([...dragged], target);
        setDrag(null);
        setDraft(null);
        return;
      }
    }
    if (drag?.type === "cards" && !drag.moved) {
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
      const s = Math.min(2.5, Math.max(0.15, view.s * Math.exp(-event.deltaY / 300)));
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
            const drawn = !stack || props.openStacks.has(stack[0]) || stack[1][0] === id;
            return kind !== undefined && PREVIEW_KINDS.has(kind) && !props.hidden.has(kind) && drawn;
          })
          .map(([id, place]) => ({ id, x: place.x * view.s + view.x, y: place.y * view.s + view.y }))
          .filter((card) => card.x > 240 && card.y > 120 && card.x < innerWidth - 400 && card.y < innerHeight)
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
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(event) => event.preventDefault()}
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
            zoomedOut={zoomedOut}
            hidden={props.hidden}
          />
        ))}
        {[...shown.resources.values()].map((resource) => {
          const place = shown.places.get(resource.id);
          if (!place || props.hidden.has(resource.kind)) return null;
          const stack = stackOf(resource.id);
          const open = stack ? props.openStacks.has(stack[0]) : false;
          const index = stack ? stack[1].indexOf(resource.id) : 0;
          if (stack && !open && index > 0) return null;
          const head = stack ? shown.places.get(stack[1][0] ?? "") : undefined;
          const own = stack?.[0].startsWith(USER_STACK) ?? false;
          // An owner's stack opens downwards, as a list; a stack by group opens in a row (K-508, K-521).
          const at =
            stack && open && head
              ? own
                ? { x: head.x, y: head.y + index * STACK_ROW }
                : { x: head.x + index * STACK_GAP, y: head.y }
              : place;
          const selected = props.selection.cards.has(resource.id);
          if (zoomedOut) {
            return (
              <div
                key={resource.id}
                data-card={resource.id}
                class={`mini${selected ? " sel" : ""}`}
                style={{ left: px(at.x), top: px(at.y), background: KINDS[resource.kind].color }}
                title={resource.name}
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
              count={stack && index === 0 ? stack[1].length : null}
              open={open}
              access={props.access[resource.id] ?? null}
              machine={props.machines.get(resource.id) ?? null}
              preview={previewIds.has(resource.id)}
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
      {draft && draft.diffs.length > 0 ? (
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
  zoomedOut: boolean;
  hidden: ReadonlySet<ResourceKind>;
}) {
  const { circle } = props;
  const shown = circle.members.slice(0, 4);
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
      class={`circle${props.selected ? " sel" : ""}${props.preview ? " preview" : ""}`}
      style={{
        left: px(circle.x - circle.r),
        top: px(circle.y - circle.r),
        width: px(circle.r * 2),
        height: px(circle.r * 2),
        "--c": circle.color,
      }}
    >
      <div class="head" data-head={circle.id}>
        <span>{circle.name}</span>
        <span
          class="sticker"
          style={{ "--tilt": LEVEL_TILTS[circle.level], background: LEVEL_COLORS[circle.level] }}
        >
          {circle.level}
        </span>
        {circle.needsPasskey ? <span title="Needs a passkey">🔑</span> : null}
        {circle.match === "all" ? <span title="Every member must match">∧</span> : null}
      </div>
      {props.zoomedOut ? (
        <div class="counts">
          {[...counts].map(([kind, count]) => (
            <span key={kind}>
              {KINDS[kind].icon} {count}
            </span>
          ))}
        </div>
      ) : (
        <div class="members">
          {shown.map((member, index) => (
            <span class="chip" key={index}>
              {MEMBER_ICONS[member._tag]} {memberLabel(member)}
            </span>
          ))}
          {extra > 0 ? (
            <span
              class="chip"
              data-head={circle.id}
              title={circle.members.slice(4).map(memberLabel).join(", ")}
            >
              +{extra}
            </span>
          ) : null}
        </div>
      )}
      <div class="grip" data-grip={circle.id} title="Resize" />
    </div>
  );
}

function CardView(props: {
  resource: Resource;
  state: State;
  at: Point;
  selected: boolean;
  dragging: boolean;
  count: number | null;
  open: boolean;
  access: AccessState | null;
  machine: MachineView | null;
  preview: boolean;
}) {
  const { resource, state } = props;
  const kind = KINDS[resource.kind];
  const holding = circlesHolding(state, resource.id);
  return (
    <div
      class={`card${props.selected ? " sel" : ""}${props.dragging ? " dragging" : ""}`}
      data-card={resource.id}
      style={{ left: px(props.at.x), top: px(props.at.y) }}
    >
      {props.count !== null ? (
        <span class="sticker count">
          {props.count}
          {props.open ? " ▾" : ""}
        </span>
      ) : null}
      {props.access?.state === "applying" ? <span class="sticker wait state">applying</span> : null}
      {props.access?.state === "failed" ? (
        <span class="sticker state" title={props.access.error}>
          failed
        </span>
      ) : null}
      <div class="name">
        {kind.icon} {resource.name}
      </div>
      <div class="sub">{resource.addresses[0] ?? resource.kind}</div>
      <div class="foot">
        <span class="sticker" style={{ "--tilt": kind.tilt, background: kind.color, color: kind.ink }}>
          {resource.kind}
        </span>
        {props.machine ? <PresenceSticker view={props.machine} /> : null}
        {holding.map((circle) => {
          const level = shareLevel(state, resource, circle);
          return (
            <span
              key={circle.id}
              class="dot"
              title={`${circle.name} · ${level ?? "none"}`}
              style={{ background: circle.color }}
            />
          );
        })}
        {holding
          .filter((circle) => state.shareSettings.get(shareKey(resource.id, circle.id))?.level)
          .map((circle) => (
            <span key={`o-${circle.id}`} class="chip" title="Level override">
              {circle.name}: {shareLevel(state, resource, circle) ?? "none"}
            </span>
          ))}
      </div>
      {props.preview && resource.addresses[0] ? <CardPreview address={resource.addresses[0]} /> : null}
    </div>
  );
}

/**
 * A live view of a site or page. A site behind Access shows only when this browser already has its Access
 * cookie: the Access login refuses to load in a frame, so "Open site" logs in in a tab.
 */
function CardPreview(props: { address: string }) {
  const [interact, setInteract] = useState(false);
  const url = `https://${props.address}`;
  return (
    <div class="preview-frame">
      <iframe
        src={url}
        title={`Preview of ${props.address}`}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        style={{ pointerEvents: interact ? "auto" : "none" }}
      />
      <div class="row" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" class="btn" onClick={() => setInteract(!interact)}>
          {interact ? "Done" : "Interact"}
        </button>
        <a class="btn" href={url} target="_blank" rel="noreferrer">
          Open site
        </a>
      </div>
      <div class="help">Blank? Open the site once to log in.</div>
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
}) {
  const holding = circlesHolding(props.state, props.id);
  return (
    <div
      class={`card stack-card${props.selected ? " sel" : ""}${props.dragging ? " dragging" : ""}`}
      data-card={props.id}
      style={{ left: px(props.at.x), top: px(props.at.y) }}
    >
      <span class="sticker count">{props.members.length} ▸</span>
      <div class="name">🗃 {props.name}</div>
      <ul>
        {props.members.slice(0, 6).map((member) => (
          <li key={member.id}>
            {KINDS[member.kind].icon} {member.name}
          </li>
        ))}
        {props.members.length > 6 ? <li class="muted">and {props.members.length - 6} more</li> : null}
      </ul>
      <div class="foot">
        {holding.map((circle) => (
          <span key={circle.id} class="dot" title={circle.name} style={{ background: circle.color }} />
        ))}
      </div>
    </div>
  );
}
