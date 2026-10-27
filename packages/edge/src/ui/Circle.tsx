import { useEffect, useRef, useState } from "preact/hooks";
import { type Edit, deepEqual } from "../core/changes.ts";
import {
  AGENT_RIGHTS,
  type AgentRight,
  type Circle,
  LEVELS,
  type Level,
  type Member,
  RESOURCE_KINDS,
  type Resource,
  type State,
  circlesHolding,
  memberLabel,
  shareKey,
  shareLevel,
} from "../core/model.ts";
import { CIRCLE_COLORS, KINDS, LEVEL_COLORS, LEVEL_TILTS, MEMBER_ICONS } from "./kinds.ts";
import { TYPED_KINDS, type TypedKind, memberFrom } from "./members.ts";
import { isAgentKey } from "../core/agent.ts";
import { callApi } from "./store.ts";

/** The sticker of each member kind: its name and a light sticker colour with black text. */
const MEMBER_STICKERS: Record<Member["_tag"], { readonly label: string; readonly color: string }> = {
  email: { label: "person", color: "var(--green)" },
  domain: { label: "domain", color: "var(--info)" },
  ip: { label: "network", color: "var(--warning)" },
  device: { label: "device", color: "var(--pink)" },
  machine: { label: "machine", color: "var(--yellow)" },
  everyone: { label: "everyone", color: "var(--green)" },
};

const COLOR_NAMES: Record<string, string> = {
  "#6C5CE7": "purple",
  "#FF5277": "red",
  "#00B3FF": "blue",
  "#FFB347": "orange",
  "#7CFF8A": "green",
  "#14B8A6": "teal",
};

const KIND_LABELS: Record<TypedKind | "device", string> = {
  auto: "auto",
  email: "person",
  domain: "domain",
  ip: "network",
  everyone: "everyone",
  device: "device",
};

const LEVEL_HELP: Record<Level, string> = {
  view: "Members can open what the circle holds.",
  use: "Members can also use machines: terminals and files.",
  control: "Members can also run commands and change settings.",
};

const DAY = 24 * 60 * 60 * 1000;
const END_PRESETS = [
  { label: "Never", after: null },
  { label: "1 day", after: DAY },
  { label: "1 week", after: 7 * DAY },
  { label: "1 month", after: 30 * DAY },
] as const;

export function Toggle(props: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      class="switch"
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="knob" />
      {props.label}
    </button>
  );
}

/** K-209, K-201: an end date from presets; Custom picks a day. */
const localDay = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

export function EndsPicker(props: { endsAt: number | null; onChange: (endsAt: number | null) => void }) {
  const [custom, setCustom] = useState(false);
  return (
    <div>
      <div class="pills">
        {END_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            aria-pressed={!custom && preset.after === null && props.endsAt === null}
            title={preset.after === null ? "No end date" : `Ends ${preset.label} from now`}
            onClick={() => {
              setCustom(false);
              props.onChange(preset.after === null ? null : Date.now() + preset.after);
            }}
          >
            {preset.label}
          </button>
        ))}
        <button type="button" aria-pressed={custom || props.endsAt !== null} onClick={() => setCustom(true)}>
          Custom…
        </button>
      </div>
      {custom ? (
        <input
          type="date"
          class="field"
          min={localDay(Date.now())}
          value={props.endsAt === null ? "" : localDay(props.endsAt)}
          onChange={(event) => {
            const value = (event.target as HTMLInputElement).value;
            if (value) props.onChange(new Date(`${value}T23:59`).getTime());
          }}
        />
      ) : null}
      {props.endsAt !== null ? (
        <p class="help">
          <span class="sticker wait">ends</span> {new Date(props.endsAt).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}

/** K-205: the level of one card in one circle; "default" follows the circle. */
export function LevelOverride(props: {
  resource: Resource;
  circle: Circle;
  state: State;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
}) {
  const { resource, circle, state } = props;
  const setting = state.shareSettings.get(shareKey(resource.id, circle.id));
  const levels: ReadonlyArray<Level> = RESOURCE_KINDS[resource.kind];
  const put = (level: Level | null) =>
    props.onEdit([
      {
        _tag: "shareSetting",
        resourceId: resource.id,
        circleId: circle.id,
        after:
          level === null && (setting?.endsAt ?? null) === null
            ? null
            : { level, endsAt: setting?.endsAt ?? null },
      },
    ]);
  return (
    <div class="seg small">
      <button type="button" aria-pressed={!setting?.level} onClick={() => void put(null)}>
        default
      </button>
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          aria-pressed={setting?.level === level}
          onClick={() => void put(level)}
        >
          {level}
        </button>
      ))}
    </div>
  );
}

/** K-718: the rights that the owner gives an agent key in its agent circle, with their stickers. */
const RIGHTS: Record<AgentRight, { readonly sticker: string; readonly label: string; readonly help: string }> = {
  addsApps: {
    sticker: "adds apps",
    label: "May add apps",
    help: "It may allow a waiting repo; its cards start in this circle (K-819)",
  },
  publishes: {
    sticker: "publishes",
    label: "May publish",
    help: "It may move its sites into the Everyone circle",
  },
};

function MemberSticker(props: {
  member: Member;
  agent: boolean;
  onRemove: () => void;
  /** Set only for an agent key in an agent circle: a right turns on or off. */
  onRight: ((right: AgentRight, on: boolean) => void) | null;
}) {
  const { member, onRight } = props;
  const kind = MEMBER_STICKERS[member._tag];
  return (
    <li class="member">
      <span class="sticker" style={{ background: kind.color }}>
        {kind.label}
      </span>
      {props.agent ? (
        <span
          class="sticker"
          style={{ background: "var(--yellow)" }}
          title="A device without the admin card: it manages only the cards of its circles (K-718)"
        >
          agent
        </span>
      ) : null}
      {member._tag === "device"
        ? AGENT_RIGHTS.filter((right) => member[right]).map((right) => (
            <span key={right} class="sticker" style={{ background: "var(--green)" }} title={RIGHTS[right].help}>
              {RIGHTS[right].sticker}
            </span>
          ))
        : null}
      <span class="who">
        {MEMBER_ICONS[props.member._tag]} {memberLabel(props.member)}
      </span>
      <button
        type="button"
        class="remove"
        title={`Remove ${memberLabel(props.member)}`}
        onClick={props.onRemove}
      >
        ×
      </button>
      {member._tag === "device" && onRight ? (
        <div class="rights">
          {AGENT_RIGHTS.map((right) => (
            <span key={right} title={RIGHTS[right].help}>
              <Toggle
                checked={member[right] === true}
                label={RIGHTS[right].label}
                onChange={(on) => onRight(right, on)}
              />
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

type DeviceMember = Extract<Member, { _tag: "device" }>;

/** A missing right is off, so turning one off removes its key. */
function withRight(member: DeviceMember, right: AgentRight, on: boolean): DeviceMember {
  const { [right]: _, ...rest } = member;
  return on ? { ...rest, [right]: true } : rest;
}

type Device = Omit<DeviceMember, "_tag">;

/** K-106: the service tokens of the account, and a new one; its secret shows once. */
export interface DeviceSecret {
  readonly name: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** K-106: a new token's secret, in a dialog that only "I saved it" closes; kitshn cannot show it again. */
export function SecretDialog(props: { secret: DeviceSecret; onClose: () => void }) {
  const { secret } = props;
  return (
    <div class="scrim">
      <div class="dialog secret" role="dialog" aria-label={`Secret of ${secret.name}`}>
        <div class="row">
          <span class="sticker">shown once</span>
          <b>{secret.name}</b>
        </div>
        <p class="help">Put these on the device now. kitshn cannot show the secret again.</p>
        {[
          ["CF-Access-Client-Id", secret.clientId],
          ["CF-Access-Client-Secret", secret.clientSecret],
        ].map(([header, value]) => (
          <div class="row" key={header}>
            <code>
              {header}: {value}
            </code>
            <button type="button" class="btn" onClick={() => void navigator.clipboard.writeText(value ?? "")}>
              Copy
            </button>
          </div>
        ))}
        <button type="button" class="btn primary" onClick={props.onClose}>
          I saved it
        </button>
      </div>
    </div>
  );
}

function DeviceList(props: {
  taken: ReadonlySet<string>;
  onAdd: (member: DeviceMember) => Promise<string | null>;
  onSecret: (secret: DeviceSecret) => void;
}) {
  const [devices, setDevices] = useState<ReadonlyArray<Device> | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    void callApi<Array<Device>>("GET", "/api/devices").then((result) => {
      if ("error" in result) setError(result.error);
      else setDevices(result);
    });
  }, [attempt]);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {error ? (
        <p class="error">
          {error}{" "}
          {devices === null ? (
            <button
              type="button"
              class="btn"
              onClick={() => {
                setError(null);
                setAttempt(attempt + 1);
              }}
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : devices === null ? (
        <p class="help">Loading the devices…</p>
      ) : null}
      <ul class="picks">
        {(devices ?? [])
          .filter((device) => !props.taken.has(device.tokenId))
          .map((device) => (
            <li key={device.tokenId}>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => setError(await props.onAdd({ _tag: "device", ...device })))
                }
              >
                📱 {device.name}
              </button>
            </li>
          ))}
        <li>
          <form
            class="row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return setError("Name the new device, for example Her phone.");
              void run(async () => {
                const result = await callApi<DeviceMember & { clientSecret: string }>(
                  "POST",
                  "/api/devices",
                  {
                    name: name.trim(),
                  },
                );
                if ("error" in result) return setError(result.error);
                setError(null);
                setName("");
                props.onSecret({
                  name: result.name,
                  clientId: result.clientId,
                  clientSecret: result.clientSecret,
                });
                setDevices([
                  ...(devices ?? []),
                  { tokenId: result.tokenId, clientId: result.clientId, name: result.name },
                ]);
                const refused = await props.onAdd({
                  _tag: "device",
                  tokenId: result.tokenId,
                  clientId: result.clientId,
                  name: result.name,
                });
                if (refused) setError(`The token exists, but the circle did not take it: ${refused}`);
              });
            }}
          >
            <input
              class="field grow"
              value={name}
              placeholder="+ New device, for example Her phone"
              onInput={(event) => setName((event.target as HTMLInputElement).value)}
            />
            <button class="btn" disabled={busy}>
              Make
            </button>
          </form>
        </li>
      </ul>
    </div>
  );
}

/** One control for every member kind: the text decides the kind, the segment overrides it. */
function AddMember(props: {
  circle: Circle;
  onAdd: (member: Member) => Promise<string | null>;
  onSecret: (secret: DeviceSecret) => void;
}) {
  const [kind, setKind] = useState<TypedKind | "device">("auto");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview =
    kind === "device" || kind === "everyone" || value.trim() === "" ? null : memberFrom(kind, value);
  const add = async () => {
    if (kind === "device") return;
    const member = memberFrom(kind, value);
    if (typeof member === "string") return setError(member);
    if (busy) return;
    setBusy(true);
    // A server refusal shows as a toast; the input keeps the text so the owner can fix it.
    const refused = await props.onAdd(member);
    setBusy(false);
    if (!refused) setValue("");
  };
  return (
    <div class="add-member">
      <div class="pills" role="group" aria-label="Member kind">
        {[...TYPED_KINDS, "device" as const].map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            onClick={() => {
              setKind(option);
              setError(null);
            }}
          >
            {KIND_LABELS[option]}
          </button>
        ))}
      </div>
      {kind === "device" ? (
        <DeviceList
          taken={
            new Set(
              props.circle.members.flatMap((member) => (member._tag === "device" ? [member.tokenId] : [])),
            )
          }
          onAdd={props.onAdd}
          onSecret={props.onSecret}
        />
      ) : (
        <form
          class="row"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          {kind !== "everyone" ? (
            <input
              class="field grow"
              value={value}
              aria-label="Member"
              placeholder="name@example.com, example.com or 10.0.0.0/8"
              onInput={(event) => {
                setValue((event.target as HTMLInputElement).value);
                setError(null);
              }}
            />
          ) : (
            <span class="help grow">Anyone who can reach the address, with no login.</span>
          )}
          <button class="btn primary" disabled={busy}>
            Add
          </button>
        </form>
      )}
      {error ? (
        <p class="error">{error}</p>
      ) : preview && typeof preview !== "string" ? (
        <p class="help">
          Adds a <b>{MEMBER_STICKERS[preview._tag].label}</b>: {memberLabel(preview)}
        </p>
      ) : null}
    </div>
  );
}

export function CircleEditor(props: {
  circle: Circle;
  state: State;
  accessTeam: string;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onDelete: (circle: Circle) => void;
  onSelectCard: (id: string) => void;
  onSecret: (secret: DeviceSecret) => void;
}) {
  const { circle, state } = props;
  // Edits that finish after a wait (a new device token) build on the circle as it is then, not as it was.
  const latest = useRef(circle);
  latest.current = circle;
  const put = (next: Partial<Circle>) =>
    props.onEdit([{ _tag: "circle", id: circle.id, after: { ...latest.current, ...next } }]);
  const addMember = (member: Member) => {
    if (latest.current.members.some((other) => deepEqual(other, member)))
      return Promise.resolve(`${memberLabel(member)} is in ${latest.current.name} already.`);
    return put({ members: [...latest.current.members, member] });
  };
  const [draft, setDraft] = useState<string | null>(null);
  const inside = [...state.resources.values()].filter((resource) =>
    circlesHolding(state, resource.id).includes(circle),
  );
  // K-718: rights count only in a circle of devices only.
  const agentCircle = circle.members.every((member) => member._tag === "device");
  const hasPeople = circle.members.some((member) => member._tag === "email" || member._tag === "domain");
  return (
    <section class="editor">
      <div class="band" style={{ background: circle.color }} />
      <div class="label">Circle</div>
      <input
        class="title"
        aria-label="Circle name"
        value={draft ?? circle.name}
        onFocus={() => setDraft(circle.name)}
        onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setDraft(null);
            event.stopPropagation();
          }
        }}
        onBlur={() => {
          const name = draft?.trim();
          setDraft(null);
          if (name && name !== circle.name) void put({ name });
        }}
      />
      <div class="swatches" role="radiogroup" aria-label="Colour">
        {[...new Set([...CIRCLE_COLORS, circle.color.toUpperCase()])].map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={circle.color.toUpperCase() === color}
            aria-label={COLOR_NAMES[color] ?? color}
            style={{ background: color }}
            onClick={() => void put({ color })}
          />
        ))}
      </div>

      <h3 class="label">Who</h3>
      <ul class="members">
        {circle.members.map((member, index) => (
          <MemberSticker
            key={member._tag === "device" ? member.tokenId : `${member._tag}-${memberLabel(member)}`}
            member={member}
            agent={isAgentKey(state, member, Date.now())}
            onRemove={() => void put({ members: circle.members.filter((_, other) => other !== index) })}
            onRight={
              member._tag === "device" && agentCircle && isAgentKey(state, member, Date.now())
                ? (right, on) =>
                    void put({
                      members: circle.members.map((other, at) => (at === index ? withRight(member, right, on) : other)),
                    })
                : null
            }
          />
        ))}
        {circle.members.length === 0 ? (
          <li class="help">Nobody yet. A circle with no members matches nobody.</li>
        ) : null}
      </ul>
      <AddMember circle={circle} onAdd={addMember} onSecret={props.onSecret} />

      <h3 class="label">Access</h3>
      <div class="field-row">
        <span class="label">Level</span>
        <div>
          <div class="seg">
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={circle.level === level}
                onClick={() => void put({ level })}
              >
                {level}
              </button>
            ))}
          </div>
          <p class="help">{LEVEL_HELP[circle.level]}</p>
        </div>
      </div>
      <div class="field-row">
        <span class="label">Match</span>
        <div>
          <div class="seg">
            <button
              type="button"
              aria-pressed={circle.match === "any"}
              onClick={() => void put({ match: "any" })}
            >
              any
            </button>
            <button
              type="button"
              aria-pressed={circle.match === "all"}
              onClick={() => void put({ match: "all" })}
            >
              all must match
            </button>
          </div>
          <p class="help">
            {circle.match === "any"
              ? "A visitor needs to match one member."
              : "A visitor must match every member, for example a domain and the office network."}
          </p>
        </div>
      </div>
      <div class="field-row">
        <span class="label">Passkey</span>
        <div>
          <Toggle
            checked={circle.needsPasskey}
            label="Needs a passkey"
            onChange={(needsPasskey) => void put({ needsPasskey })}
          />
          <p class="help">People also confirm with Touch ID, Windows Hello or a security key.</p>
          {circle.needsPasskey && hasPeople && props.accessTeam ? (
            <p class="help">
              A new person enrolls a passkey once, on the first login:{" "}
              <a href={`https://${props.accessTeam}/AddMfaDevice`} target="_blank" rel="noreferrer">
                <code>{props.accessTeam}/AddMfaDevice</code>
              </a>
            </p>
          ) : null}
        </div>
      </div>
      <div class="field-row">
        <span class="label">Ends</span>
        <EndsPicker endsAt={circle.endsAt} onChange={(endsAt) => void put({ endsAt })} />
      </div>

      <h3 class="label">What it opens ({inside.length})</h3>
      <ul class="opens">
        {inside.map((resource) => {
          const level = shareLevel(state, resource, circle);
          return (
            <li key={resource.id}>
              <button type="button" class="open-card" onClick={() => props.onSelectCard(resource.id)}>
                <span class="name">
                  {KINDS[resource.kind].icon} {resource.name}
                </span>
                <span
                  class="sticker"
                  style={{
                    "--tilt": level ? LEVEL_TILTS[level] : "0deg",
                    background: level ? LEVEL_COLORS[level] : undefined,
                  }}
                >
                  {level ?? "none"}
                </span>
              </button>
              {RESOURCE_KINDS[resource.kind].length > 1 ? (
                <LevelOverride resource={resource} circle={circle} state={state} onEdit={props.onEdit} />
              ) : null}
            </li>
          );
        })}
        {inside.length === 0 ? <li class="help">Nothing yet. Drag cards into the circle.</li> : null}
      </ul>

      <div class="danger-zone">
        <h3 class="label">Danger</h3>
        <p class="help">Its cards stay where they are and lose this share.</p>
        <button type="button" class="btn danger" onClick={() => props.onDelete(circle)}>
          Delete {circle.name}
        </button>
      </div>
    </section>
  );
}
