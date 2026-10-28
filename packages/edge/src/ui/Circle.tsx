import { useEffect, useId, useRef, useState } from "preact/hooks";
import { type Edit, deepEqual } from "../core/changes.ts";
import {
  AGENT_RIGHTS,
  AGENT_RIGHT_NAMES,
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
import { CIRCLE_COLORS, LEVEL_COLORS, LEVEL_TILTS, MEMBER_ICONS } from "./kinds.ts";
import { TYPED_KINDS, type TypedKind, memberFrom } from "./members.ts";
import { isAgentKey } from "../core/agent.ts";
import { callApi } from "./store.ts";
import { Check, Switch } from "./controls.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import { levelEdit } from "./actions.ts";

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

/** What each member kind matches, with an example (K-106, K-107, K-202). */
export const MEMBER_HELP: Record<Member["_tag"], string> = {
  email: "Person: one email that logs in, for example name@example.com.",
  domain: "Domain: every email of an email domain that logs in, for example example.com.",
  ip: "Network: a visitor from an IP range, with no login, for example 10.0.0.0/8 or 203.0.113.9.",
  device: "Device: a device that proves itself with an Access service token, for example Yarden's phone.",
  machine: "Machine: a machine with a daemon, so a share can give one machine access to another resource.",
  everyone: "Everyone: anyone who can reach the address, with no login.",
};

const KIND_OPTIONS: Record<TypedKind | "device", { readonly label: string; readonly tip: string }> = {
  auto: {
    label: "auto",
    tip: "Auto: the text decides the kind, for example name@example.com is a person, example.com a domain and 10.0.0.0/8 a network.",
  },
  email: { label: "person", tip: MEMBER_HELP.email },
  domain: { label: "domain", tip: MEMBER_HELP.domain },
  ip: { label: "network", tip: MEMBER_HELP.ip },
  everyone: { label: "everyone", tip: MEMBER_HELP.everyone },
  device: { label: "device", tip: `${MEMBER_HELP.device} Pick one or make a new token.` },
};

const LEVEL_HELP: Record<Level, string> = {
  view: "Members can open what the circle holds.",
  use: "Members can also use machines: terminals and files.",
  control: "Members can also run commands and change settings.",
};

/** What each level allows on each resource kind (K-206, K-301). */
export const LEVEL_TIPS: Record<Level, string> = {
  view: "View: members open what the circle holds. Sites, pages, files and repos have only this level.",
  use: "Use: on a machine, members also use terminals and files. A kind without use, such as a site, gets view.",
  control:
    "Control: on a machine, members also run commands and change settings; on the kitshn admin, they change kitshn. A site gets view.",
};

/** K-203 */
export const MATCH_TIPS = {
  any: "Any: the visitor matches at least one member.",
  all: "All must match: the visitor matches every member, for example a domain and an IP range.",
} as const;

/** K-103 */
export const PASSKEY_TIP =
  "Needs a passkey: after the login, a visitor also confirms with a passkey or a security key.";

const DAY = 24 * 60 * 60 * 1000;
const END_PRESETS = [
  { label: "Never", after: null },
  { label: "1 day", after: DAY },
  { label: "1 week", after: 7 * DAY },
  { label: "1 month", after: 30 * DAY },
] as const;

/**
 * The end of the day that is `days` days from now (0 is today), in local time. Null for text that is no
 * such day, or for an end that has passed already.
 */
const endOfDayIn = (days: string): number | null => {
  const count = Number(days);
  if (days === "" || !Number.isInteger(count) || count < 0) return null;
  const date = new Date();
  date.setDate(date.getDate() + count);
  date.setHours(23, 59, 0, 0);
  const time = date.getTime();
  return Number.isFinite(time) && time > Date.now() ? time : null;
};

/**
 * K-209, K-201: an end date from presets; Custom takes a number of days, so no native date picker shows.
 * `ends` says what happens at the end, for the tooltips.
 */
export function EndsPicker(props: {
  endsAt: number | null;
  ends: string;
  onChange: (endsAt: number | null) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [days, setDays] = useState("");
  const customEnd = endOfDayIn(days);
  const invalid = days !== "" && customEnd === null;
  const errorId = useId();
  return (
    <div>
      <div class="pills">
        {END_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            aria-pressed={!custom && preset.after === null && props.endsAt === null}
            data-tip={
              preset.after === null
                ? "Never: no end date."
                : `${preset.label}: ${props.ends} ${preset.label} from now.`
            }
            onClick={() => {
              setCustom(false);
              props.onChange(preset.after === null ? null : Date.now() + preset.after);
            }}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={custom || props.endsAt !== null}
          data-tip={`Custom: pick the number of days; ${props.ends} at the end of that day.`}
          onClick={() => setCustom(true)}
        >
          Custom…
        </button>
      </div>
      {custom ? (
        <form
          class="row"
          onSubmit={(event) => {
            event.preventDefault();
            if (customEnd !== null) props.onChange(customEnd);
          }}
        >
          <input
            class="grow"
            inputMode="numeric"
            aria-label="Days from now"
            placeholder="Days from now, for example 3"
            data-tip={`The number of days from today, 0 for today; ${props.ends} at the end of that day.`}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            value={days}
            onInput={(event) => setDays(event.currentTarget.value.trim())}
          />
          <button class="btn" disabled={customEnd === null} data-tip="Set this end date.">
            Set
          </button>
        </form>
      ) : null}
      {custom && invalid ? (
        <p class="error" id={errorId}>
          Type a whole number of days: 0 for today, 1 for tomorrow.
        </p>
      ) : null}
      {props.endsAt !== null ? (
        <p class="help">
          <span class="sticker wait" data-tip={`Ends: ${props.ends} at this time.`}>
            ends
          </span>{" "}
          {new Date(props.endsAt).toLocaleString()}
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
  const put = (level: Level | null) => props.onEdit([levelEdit(state, resource, circle, level)]);
  return (
    <div class="seg small">
      <button
        type="button"
        aria-pressed={!setting?.level}
        data-tip={`Default: this card follows the level of ${circle.name}, now ${circle.level}.`}
        onClick={() => void put(null)}
      >
        default
      </button>
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          aria-pressed={setting?.level === level}
          data-tip={`${level}: this card gets ${level} in ${circle.name}, whatever the default. The card shows the override as a chip.`}
          onClick={() => void put(level)}
        >
          {level}
        </button>
      ))}
    </div>
  );
}

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
      <span class="sticker" style={{ background: kind.color }} data-tip={MEMBER_HELP[member._tag]}>
        {kind.label}
      </span>
      {props.agent ? (
        <span class="sticker" style={{ background: "var(--yellow)" }} data-tip={AGENT_TIP}>
          agent
        </span>
      ) : null}
      {member._tag === "device" && onRight ? <RightStickers member={member} /> : null}
      <span class="who">
        {MEMBER_ICONS[props.member._tag]} {memberLabel(props.member)}
      </span>
      <button
        type="button"
        class="remove"
        aria-label={`Remove ${memberLabel(props.member)}`}
        data-tip={`Remove ${memberLabel(props.member)} from this circle.`}
        onClick={props.onRemove}
      >
        ×
      </button>
      {member._tag === "device" && onRight ? (
        <div class="rights">
          {AGENT_RIGHTS.map((right) => (
            <Check
              key={right}
              checked={member[right] === true}
              label={AGENT_RIGHT_NAMES[right]}
              tip={RIGHT_HELP[right]}
              onChange={(on) => onRight(right, on)}
            />
          ))}
          <span class="help">A right counts from any agent circle of this key.</span>
        </div>
      ) : null}
    </li>
  );
}

type DeviceMember = Extract<Member, { _tag: "device" }>;

const RIGHT_STICKERS: Record<AgentRight, string> = { addsApps: "adds apps", publishes: "publishes" };
const RIGHT_HELP: Record<AgentRight, string> = {
  addsApps:
    "Adds apps: the key allows a waiting repo. Its new cards start in the key's first agent circle at control.",
  publishes:
    "Publishes: the key publishes a card of a repo that it allowed, into the overlap of an agent circle and Everyone.",
};

export const AGENT_TIP =
  "Agent: a device member without the admin card. It manages only the cards that its agent circles hold at control.";

/** K-718: a sticker for each right of an agent key, on its chip in the circle editor and on the map. */
export function RightStickers(props: { member: DeviceMember }) {
  return (
    <>
      {AGENT_RIGHTS.filter((right) => props.member[right]).map((right) => (
        <span key={right} class="sticker right" data-tip={RIGHT_HELP[right]}>
          {RIGHT_STICKERS[right]}
        </span>
      ))}
    </>
  );
}

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
          <span class="sticker" data-tip="kitshn shows this secret only now and cannot show it again.">
            shown once
          </span>
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
            <button
              type="button"
              class="btn"
              data-tip={`Copy the ${header} header to the clipboard.`}
              onClick={() => void navigator.clipboard.writeText(value ?? "")}
            >
              Copy
            </button>
          </div>
        ))}
        <button
          type="button"
          class="btn primary"
          data-tip="Close this dialog. The secret is gone after this."
          onClick={props.onClose}
        >
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
              data-tip="Load the device list again."
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
                data-tip={`Add the device ${device.name} to this circle.`}
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
              aria-label="New device name"
              data-tip="The name of a new device token. kitshn makes the token and adds the device to this circle."
              placeholder="+ New device, for example Her phone"
              onInput={(event) => setName((event.target as HTMLInputElement).value)}
            />
            <button
              class="btn"
              disabled={busy}
              data-tip="Make a service token for the new device and show its secret once."
            >
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
            data-tip={KIND_OPTIONS[option].tip}
            onClick={() => {
              setKind(option);
              setError(null);
            }}
          >
            {KIND_OPTIONS[option].label}
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
              data-tip="An email, an email domain or a network. The kind above decides how kitshn reads it."
              placeholder="name@example.com, example.com or 10.0.0.0/8"
              onInput={(event) => {
                setValue((event.target as HTMLInputElement).value);
                setError(null);
              }}
            />
          ) : (
            <span class="help grow">Anyone who can reach the address, with no login.</span>
          )}
          <button class="btn primary" disabled={busy} data-tip={`Add this member to ${props.circle.name}.`}>
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
        data-tip="The name of the circle. Enter saves it; Escape cancels."
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
            data-tip={`${COLOR_NAMES[color] ?? color}: the colour of the ring on the map. It changes no access.`}
            style={{ background: color }}
            onClick={() => void put({ color })}
          />
        ))}
      </div>

      <h3 class="label" data-tip="Who: the members of the circle. A circle with no members matches nobody.">
        Who
      </h3>
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
                      members: circle.members.map((other, at) =>
                        at === index ? withRight(member, right, on) : other,
                      ),
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
        <span class="label" data-tip="Level: what a share allows. Each resource kind names its own levels.">
          Level
        </span>
        <div>
          <div class="seg">
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={circle.level === level}
                data-tip={LEVEL_TIPS[level]}
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
        <span class="label" data-tip="Match: how a visitor matches the members of this circle.">
          Match
        </span>
        <div>
          <div class="seg">
            <button
              type="button"
              aria-pressed={circle.match === "any"}
              data-tip={MATCH_TIPS.any}
              onClick={() => void put({ match: "any" })}
            >
              any
            </button>
            <button
              type="button"
              aria-pressed={circle.match === "all"}
              data-tip={MATCH_TIPS.all}
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
        <span class="label" data-tip={PASSKEY_TIP}>
          Passkey
        </span>
        <div>
          <Switch
            checked={circle.needsPasskey}
            label="Needs a passkey"
            tip={PASSKEY_TIP}
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
        <span class="label" data-tip="Ends: after this date the circle stops giving access.">
          Ends
        </span>
        <EndsPicker
          endsAt={circle.endsAt}
          ends="the circle stops giving access"
          onChange={(endsAt) => void put({ endsAt })}
        />
      </div>

      <h3 class="label" data-tip="What it opens: every card inside the circle, with the level that it gets.">
        What it opens ({inside.length})
      </h3>
      <ul class="opens">
        {inside.map((resource) => {
          const level = shareLevel(state, resource, circle);
          return (
            <li key={resource.id}>
              <button
                type="button"
                class="open-card"
                data-tip={`Select ${resource.name} and show its panel.`}
                onClick={() => props.onSelectCard(resource.id)}
              >
                <span class="name">
                  <ItemIcon resource={resource} />
                  {resource.name}
                </span>
                <span
                  class="sticker"
                  data-tip={
                    level ? LEVEL_TIPS[level] : "None: this kind has no level at or below the circle's level."
                  }
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
        <button
          type="button"
          class="btn danger"
          data-tip={`Delete ${circle.name}. Its cards stay where they are and lose this share; Undo brings it back.`}
          onClick={() => props.onDelete(circle)}
        >
          Delete {circle.name}
        </button>
      </div>
    </section>
  );
}
