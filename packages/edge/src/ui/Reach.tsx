import {
  type Circle,
  type Level,
  type Point,
  type Resource,
  type State,
  levelRank,
  shareKey,
  sharesOf,
} from "../core/model.ts";
import { type Box, cardBox } from "../core/place.ts";
import { type Capability, type ReachLine, capabilitiesOf } from "../core/reach.ts";
import { LEVEL_TIPS } from "./Circle.tsx";
import { LEVEL_COLORS, LEVEL_LINES } from "./kinds.ts";

/** K-507: a card shows this many share chips, then "+N". */
const SHOWN_CHIPS = 2;

/** K-507: one chip per circle that shares the card, highest level first, at most two and "+N". */
export function ShareChips(props: { readonly state: State; readonly resource: Resource }) {
  const { state, resource } = props;
  const shares = sharesOf(state, resource).sort((a, b) => levelRank(b.level) - levelRank(a.level));
  if (shares.length === 0) return null;
  const rest = shares.slice(SHOWN_CHIPS);
  return (
    <div class="shares">
      {shares.slice(0, SHOWN_CHIPS).map(({ circle, level }) => {
        const override = state.shareSettings.get(shareKey(resource.id, circle.id))?.level !== undefined;
        return (
          <span
            key={circle.id}
            class="share"
            tabIndex={0}
            style={{ "--circle": circle.color }}
            data-tip={`Shared with ${circle.name} at ${level}${override ? ", its own level for this card, not the circle's default (K-205)" : ""}. ${LEVEL_TIPS[level]}`}
          >
            <span class="who">{circle.name}</span>
            {override ? <span aria-label="own level">✎</span> : null}
            <span class="lv" style={{ background: LEVEL_COLORS[level] }}>
              {level}
            </span>
          </span>
        );
      })}
      {rest.length > 0 ? (
        <MoreChip names={rest.map(({ circle, level }) => `${circle.name} (${level})`)} />
      ) : null}
    </div>
  );
}

/** K-507: a closed stack names the circles that hold all of its cards. */
export function CircleChips(props: { readonly circles: ReadonlyArray<Circle> }) {
  if (props.circles.length === 0) return null;
  const rest = props.circles.slice(SHOWN_CHIPS);
  return (
    <div class="shares">
      {props.circles.slice(0, SHOWN_CHIPS).map((circle) => (
        <span
          key={circle.id}
          class="share"
          tabIndex={0}
          style={{ "--circle": circle.color }}
          data-tip={`${circle.name}: every card of this stack is shared with this circle.`}
        >
          <span class="who">{circle.name}</span>
        </span>
      ))}
      {rest.length > 0 ? <MoreChip names={rest.map((circle) => circle.name)} /> : null}
    </div>
  );
}

function MoreChip(props: { readonly names: ReadonlyArray<string> }) {
  return (
    <span
      class="share more-shares"
      tabIndex={0}
      data-tip={`Also shared with ${props.names.join(", ")}. The panel lists every circle.`}
    >
      +{props.names.length}
    </span>
  );
}

const CAPABILITIES: Record<Capability, { readonly words: string; readonly tip: string }> = {
  open: { words: "opens it", tip: "Opens its address." },
  exec: { words: "runs shell commands", tip: "Runs shell commands on it (K-614)." },
};

function CapabilityIcon(props: { readonly capability: Capability }) {
  return (
    <svg
      class="cap"
      viewBox="0 0 24 24"
      role="img"
      aria-label={CAPABILITIES[props.capability].tip}
      data-tip={CAPABILITIES[props.capability].tip}
    >
      {props.capability === "open" ? (
        <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />
      ) : (
        <path d="M4 7l5 5-5 5M12 18h8" />
      )}
    </svg>
  );
}

/** The end of a line on the edge of a card box, toward `toward`. */
function edgePoint(box: Box, toward: Point): Point {
  const center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const scale = Math.min(
    (box.right - box.left) / 2 / Math.max(Math.abs(dx), 1e-6),
    (box.bottom - box.top) / 2 / Math.max(Math.abs(dy), 1e-6),
  );
  return { x: center.x + dx * Math.min(scale, 1), y: center.y + dy * Math.min(scale, 1) };
}

/** A line bends away from the straight path, outgoing lines to one side and incoming to the other. */
const BEND = 28;

/**
 * K-537: the relationship lens, drawn in map units inside the panned world, so pan and zoom never redraw it. It
 * exists only while one card is selected; a drag redraws its few paths, and nothing moves on its own.
 */
export function ReachLayer(props: {
  readonly state: State;
  readonly selected: string;
  readonly lines: ReadonlyArray<ReachLine>;
  /** Where each shown card draws, by card id; a card in a closed stack draws at the stack. */
  readonly drawn: ReadonlyMap<string, Point>;
}) {
  const { state } = props;
  const shapes = props.lines.flatMap((line) => {
    const to = props.drawn.get(line.to);
    const target = state.resources.get(line.to);
    const circle = line.from._tag === "circle" ? state.circles.get(line.from.id) : undefined;
    // A circle head line starts at the middle of the circle's top edge.
    const from = circle ? { x: circle.x, y: circle.y - circle.r } : props.drawn.get(line.from.id);
    if (!to || !from || !target || (from.x === to.x && from.y === to.y)) return [];
    const toBox = cardBox(to);
    const fromBox = circle ? null : cardBox(from);
    const toCenter = { x: (toBox.left + toBox.right) / 2, y: (toBox.top + toBox.bottom) / 2 };
    const p0 = fromBox ? edgePoint(fromBox, toCenter) : from;
    const p1 = edgePoint(toBox, p0);
    const length = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const bend = line.to === props.selected ? -BEND : BEND;
    const control = {
      x: (p0.x + p1.x) / 2 - ((p1.y - p0.y) / length) * bend,
      y: (p0.y + p1.y) / 2 + ((p1.x - p0.x) / length) * bend,
    };
    const middle = { x: (p0.x + 2 * control.x + p1.x) / 4, y: (p0.y + 2 * control.y + p1.y) / 4 };
    return [{ line, target, p0, p1, control, middle, key: `${line.from._tag}:${line.from.id}>${line.to}` }];
  });
  return (
    <>
      <svg class="lens" aria-hidden="true">
        <defs>
          <marker
            id="lens-head"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="14"
            markerHeight="14"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0L10 5L0 10z" />
          </marker>
        </defs>
        {shapes.map(({ line, p0, p1, control, key }) => {
          const style = line.level ? LEVEL_LINES[line.level] : { width: 2, dash: "2 5" };
          return (
            <path
              key={key}
              d={`M${p0.x} ${p0.y}Q${control.x} ${control.y} ${p1.x} ${p1.y}`}
              stroke-width={style.width}
              stroke-dasharray={style.dash ?? undefined}
              marker-end="url(#lens-head)"
            />
          );
        })}
      </svg>
      {shapes.map(({ line, target, middle, key }) => (
        <span
          key={key}
          class="lens-pill"
          style={{ left: `${middle.x}px`, top: `${middle.y}px` }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {line.level ? <LevelTag level={line.level} /> : null}
          {line.level
            ? capabilitiesOf(target, line.level).map((each) => (
                <CapabilityIcon key={each} capability={each} />
              ))
            : null}
          <span class="who">{reachLabel(state, line)}</span>
        </span>
      ))}
    </>
  );
}

function LevelTag(props: { readonly level: Level }) {
  return (
    <span class="lv" style={{ background: LEVEL_COLORS[props.level] }} data-tip={LEVEL_TIPS[props.level]}>
      {props.level}
    </span>
  );
}

/** The short text of a line: the circles that give the level, how many members a head stands for, and "runs". */
function reachLabel(state: State, line: ReachLine) {
  const parts = [
    ...(line.from._tag === "circle" ? [`${line.members} member${line.members === 1 ? "" : "s"}`] : []),
    ...(line.from._tag === "card" && line.via.length > 0 ? [`via ${line.via.join(", ")}`] : []),
    ...(line.runs ? [`runs ${state.resources.get(line.to)?.name ?? "it"}`] : []),
  ];
  return parts.join(" · ");
}

const endName = (state: State, line: ReachLine, end: "from" | "to") =>
  end === "to"
    ? (state.resources.get(line.to)?.name ?? line.to)
    : line.from._tag === "circle"
      ? (state.circles.get(line.from.id)?.name ?? line.from.id)
      : (state.resources.get(line.from.id)?.name ?? line.from.id);

/** K-537: the lens as a list in the card panel, for a phone and the keyboard. */
export function ReachList(props: {
  readonly state: State;
  readonly selected: string;
  readonly lines: ReadonlyArray<ReachLine>;
}) {
  const { state } = props;
  if (props.lines.length === 0) return null;
  const incoming = props.lines.filter((line) => line.to === props.selected);
  const outgoing = props.lines.filter((line) => line.to !== props.selected);
  const row = (line: ReachLine, end: "from" | "to") => {
    const target = state.resources.get(line.to);
    const capabilities = line.level && target ? capabilitiesOf(target, line.level) : [];
    return (
      <li key={`${line.from._tag}:${line.from.id}>${line.to}`} class="row">
        <b>
          {end === "from" ? "← " : "→ "}
          {endName(state, line, end)}
        </b>
        {line.level ? <LevelTag level={line.level} /> : null}
        <span>
          {[reachLabel(state, line), ...capabilities.map((each) => CAPABILITIES[each].words)]
            .filter((text) => text !== "")
            .join(" · ")}
        </span>
      </li>
    );
  };
  return (
    <>
      <div
        class="label"
        style={{ marginTop: "12px" }}
        data-tip="Reach: what reaches this card and what it reaches, with the level. Select a card on the map to see it as lines."
      >
        Reach
      </div>
      <ul class="reach">
        {incoming.map((line) => row(line, "from"))}
        {outgoing.map((line) => row(line, "to"))}
      </ul>
    </>
  );
}
