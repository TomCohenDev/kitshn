// K-702: the messages of the daemon's local socket (K-701). One JSON value per line. A request carries an id,
// its answer the same id. An event carries no id (K-703): the result of an ask that waited (K-1722).
import { Schema } from "effect";
import {
  CardSettingValues,
  LinkAudit,
  ReachedCard,
  DesiredParts,
  GrantTables,
  PROVIDER_LIMITS,
  ProviderCommand,
  ProviderKind,
  ProviderName,
  ProviderResource,
} from "./provider.ts";

export * from "./provider.ts";

/** The longest line, in UTF-16 code units, that the daemon reads; a longer line ends the connection. */
/** K-1714: room for a forwarded body of `MAX_FORWARD_BYTES` in base64 and its request. */
export const MAX_LINE_LENGTH = 17 * 1024 * 1024;

/**
 * K-1714: the largest body that the daemon forwards, each way. Known limit: a bigger file needs an agent key; revisit
 * when an agent needs to publish one through its machine.
 */
export const MAX_FORWARD_BYTES = 12 * 1024 * 1024;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** K-1711: what an agent may ask kitshn for. */
export const ASK_ACTIONS = [
  "state",
  "apply",
  "publish",
  "allow",
  "deploy",
  "job",
  "job-read",
  "github-token",
  "audience-add",
  "audience-remove",
  "pass",
  "approve",
  "deny",
  "history",
  "backup",
  "restore",
] as const;
export type AskAction = (typeof ASK_ACTIONS)[number];

/** K-1723: the asks whose approval only opens a window; the daemon asks again to get the secret. */
export const WINDOW_ACTIONS: ReadonlySet<AskAction> = new Set(["github-token", "pass"]);

/** K-1750: at most 10 labels; a key of `a-z`, `0-9`, `.` and `-` with a prefix, a value of at most 256 characters. */
export const MAX_LABELS = 10;
const LABEL_KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789.-";
export const isLabelKey = (key: string) =>
  key.length > 0 &&
  key.length <= 64 &&
  key.includes(".") &&
  !key.startsWith(".") &&
  !key.endsWith(".") &&
  [...key].every((char) => LABEL_KEY_CHARS.includes(char));
const Labels = Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(256)));

/** K-1710: one ask. `body` carries what the action needs, such as the edits of `apply` or the command of `job`. */
const Ask = Schema.Struct({
  id: Id,
  type: Schema.Literal("ask"),
  action: Schema.Literals(ASK_ACTIONS),
  target: Schema.String.check(Schema.isMaxLength(512)),
  body: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  labels: Schema.optionalKey(Labels),
  /** K-1752: the values of the attesters' token variables, by name; the daemon sends each only to its attester. */
  attestations: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(4096))),
  ),
});
export type Ask = typeof Ask.Type;

export const Request = Schema.Union([
  /** The machine id, the key fingerprint, the connection to kitshn and the tunnel service (K-605). */
  Schema.Struct({ id: Id, type: Schema.Literal("status") }),
  /** K-1705: rotate the machine key over the live connection. */
  Schema.Struct({ id: Id, type: Schema.Literal("rotate-key") }),
  /** K-1706: `kitshn rekey` saved a new key; connect again with it. */
  Schema.Struct({ id: Id, type: Schema.Literal("reconnect") }),
  /**
   * K-1714: one HTTP call to `/agent` that the daemon sends with the machine token and signs with the machine key, for
   * the commands that publish, set addresses, read logs and make repos. `body` is base64.
   */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("forward"),
    method: Schema.Literals(["GET", "POST", "DELETE"]),
    path: Schema.String.check(Schema.isMaxLength(2048)),
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(1024)))),
    body: Schema.optionalKey(Schema.String),
    attestations: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(4096))),
    ),
  }),
  /**
   * K-1751: the T3 server (or another local service) registers its attester on start, with its real loopback
   * address. Only the daemon user and root send it; an entry of the same prefix is replaced.
   */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("attester-set"),
    prefix: Schema.String.check(Schema.isMaxLength(32)),
    url: Schema.String.check(Schema.isMaxLength(512)),
    tokenEnv: Schema.String.check(Schema.isMaxLength(128)),
  }),
  /** K-1762: `git credential erase` drops the kept tokens of one repo. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("forget-token"),
    repo: Schema.String.check(Schema.isMaxLength(512)),
  }),
  /**
   * K-704: a provider names its kinds, its commands and all its resources; this replaces what an earlier connection
   * registered. The connection then gets `grants` and `command` events. Only the daemon user and root send it.
   */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("register"),
    provider: ProviderName,
    kinds: Schema.Array(ProviderKind).check(Schema.isMaxLength(PROVIDER_LIMITS.kinds)),
    commands: Schema.Array(ProviderCommand).check(Schema.isMaxLength(PROVIDER_LIMITS.commands)),
    resources: Schema.Array(ProviderResource).check(Schema.isMaxLength(PROVIDER_LIMITS.resources)),
  }),
  /** K-705: adds or replaces resources of a provider that this connection registered. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("upsert"),
    provider: ProviderName,
    resources: Schema.Array(ProviderResource).check(Schema.isMaxLength(PROVIDER_LIMITS.resources)),
  }),
  /** K-705: removes resources of a provider that this connection registered, by their ids. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("remove"),
    provider: ProviderName,
    ids: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(
      Schema.isMaxLength(PROVIDER_LIMITS.resources),
    ),
  }),
  /** K-704: `kitshn provider forget <name>`: the daemon drops a provider that does not run, so it no longer reports it. */
  Schema.Struct({ id: Id, type: Schema.Literal("provider-forget"), provider: ProviderName }),
  /**
   * K-709: a provider sets the part of a desired state of this machine, or the shared part. kitshn stores it and pushes
   * it to every machine of the provider. Only the connection that registered the provider sends it.
   */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("desired-set"),
    provider: ProviderName,
    kind: Schema.String.check(Schema.isMaxLength(64)),
    part: Schema.Literals(["shared", "machine"]),
    value: Schema.Unknown,
  }),
  /** K-1612: cancels a job of this machine while it waits in the queue: one that runs here, or one that it queued. */
  Schema.Struct({ id: Id, type: Schema.Literal("job-cancel"), jobId: Schema.Int }),
  /** K-605, K-606: the resource sample now and the samples of the last hour, read on this machine only. */
  Schema.Struct({ id: Id, type: Schema.Literal("samples") }),
  /** K-1610: the provider reports one exec run or forwarded tool call on another machine. */
  Schema.Struct({ id: Id, type: Schema.Literal("audit"), provider: ProviderName, audit: LinkAudit }),
  /** K-707: the result of a `command` event. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("command-result"),
    provider: ProviderName,
    commandId: Schema.Int,
    ok: Schema.Boolean,
    output: Schema.String.check(Schema.isMaxLength(64 * 1024)),
  }),
  Ask,
]);
export type Request = typeof Request.Type;
export type ProviderRequest = Extract<Request, { type: "register" | "upsert" | "remove" | "command-result" }>;

/** K-605: one resource sample; each share is between 0 and 1. */
export const Sample = Schema.Struct({
  at: Schema.Number,
  cpu: Schema.Number,
  memory: Schema.Number,
  disk: Schema.Number,
});
export type Sample = typeof Sample.Type;

export const Status = Schema.Struct({
  version: Schema.String,
  machineId: Schema.String,
  /** Null when this machine has no `machine.key` (K-1708). */
  fingerprint: Schema.NullOr(Schema.String),
  /** `token-only`: kitshn has no key for this machine and reads only its status (K-1708). */
  connection: Schema.Literals(["connected", "token-only", "disconnected"]),
  tunnel: Schema.Literals(["starting", "running", "stopped"]),
  /** K-1127: the address of kitshn, for the files of a new repo. */
  server: Schema.optionalKey(Schema.String),
  /** K-1752: the variables whose values the commands send with an ask, for the attesters of this machine. */
  attesterEnv: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type Status = typeof Status.Type;

export const Answer = Schema.Union([
  Schema.Struct({ id: Id, type: Schema.Literal("status"), status: Status }),
  Schema.Struct({ id: Id, type: Schema.Literal("rotate-key"), fingerprint: Schema.String }),
  Schema.Struct({ id: Id, type: Schema.Literal("reconnect") }),
  Schema.Struct({ id: Id, type: Schema.Literal("forget-token") }),
  /** K-1751: the attesters of `machine.json` after the change. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("attester-set"),
    attesters: Schema.Array(
      Schema.Struct({ prefix: Schema.String, address: Schema.String, tokenEnv: Schema.String }),
    ),
  }),
  /** K-1714: kitshn's answer to a forwarded call; `body` is base64. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("forward"),
    status: Schema.Number,
    contentType: Schema.String,
    body: Schema.String,
  }),
  /** K-1710: kitshn ran the ask; `result` is what the action gives. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("ask"),
    outcome: Schema.Literal("done"),
    result: Schema.Unknown,
  }),
  /** K-1722: the ask waits for an answer of its approver circle; an `ask-result` event follows. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("ask"),
    outcome: Schema.Literal("waiting"),
    proposalId: Schema.String,
  }),
  Schema.Struct({
    id: Id,
    type: Schema.Literal("ask"),
    outcome: Schema.Literal("refused"),
    reason: Schema.String,
    /** K-1776: the right that is off. */
    need: Schema.optionalKey(Schema.String),
  }),
  /** K-1760: the repo's owner is "not kitshn", so the machine uses its own login. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("ask"),
    outcome: Schema.Literal("not-kitshn"),
    reason: Schema.String,
  }),
  /** K-1722 to K-1724: the answer to a waiting ask. An event: it has no id. */
  Schema.Struct({
    type: Schema.Literal("ask-result"),
    proposalId: Schema.String,
    outcome: Schema.Literals(["approved", "denied", "expired"]),
    result: Schema.optionalKey(Schema.Unknown),
    reason: Schema.optionalKey(Schema.String),
  }),
  /** K-704, K-706: the machine of the daemon, and the grant tables that kitshn last sent for this provider. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("register"),
    machineId: Schema.String,
    grants: GrantTables,
    /** K-709, K-1608: the saved desired state of each kind of the provider, from before kitshn answers. */
    desired: Schema.Record(Schema.String, DesiredParts),
    /** K-717: the saved value of each card setting, by resource id and setting id. */
    settings: CardSettingValues,
    /** K-1609: the saved reach of this machine. */
    reach: Schema.Array(ReachedCard),
    /** K-1609: the Unix socket of the link proxy: `http://link/<machine id>/<path>` reaches that machine's card. */
    linkSocket: Schema.String,
    /** The name of this machine on the map; null before its first connection to kitshn. */
    machineName: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ id: Id, type: Schema.Literal("desired-set") }),
  Schema.Struct({ id: Id, type: Schema.Literal("audit") }),
  Schema.Struct({ id: Id, type: Schema.Literal("job-cancel") }),
  Schema.Struct({ id: Id, type: Schema.Literal("samples"), newest: Sample, history: Schema.Array(Sample) }),
  /** K-1609: an event: the cards of this provider on other machines that this machine reaches, on each change. */
  Schema.Struct({ type: Schema.Literal("reach"), provider: Schema.String, cards: Schema.Array(ReachedCard) }),
  /** K-709: an event: the desired state of one kind, on each change. */
  Schema.Struct({
    type: Schema.Literal("desired"),
    provider: Schema.String,
    kind: Schema.String,
    state: DesiredParts,
  }),
  /** K-717: an event: the card settings of the provider's cards, on each change. */
  Schema.Struct({ type: Schema.Literal("settings"), provider: Schema.String, values: CardSettingValues }),
  Schema.Struct({ id: Id, type: Schema.Literal("upsert") }),
  Schema.Struct({ id: Id, type: Schema.Literal("remove") }),
  Schema.Struct({ id: Id, type: Schema.Literal("command-result") }),
  Schema.Struct({ id: Id, type: Schema.Literal("provider-forget") }),
  /** K-706: an event: the grant tables of every resource of the provider, sent on each change. */
  Schema.Struct({ type: Schema.Literal("grants"), provider: Schema.String, tables: GrantTables }),
  /**
   * K-707: an event: run one command. `resource` is the provider's id of the card, null for a command of the machine.
   * The provider answers with `command-result` and the same `commandId`.
   */
  Schema.Struct({
    type: Schema.Literal("command"),
    provider: Schema.String,
    commandId: Schema.Int,
    command: Schema.String,
    resource: Schema.NullOr(Schema.String),
    /** K-1625: the row of a list that the command is for. */
    row: Schema.optionalKey(Schema.String),
  }),
  /** The id is null when the line has no valid id. */
  Schema.Struct({ id: Schema.NullOr(Id), type: Schema.Literal("error"), error: Schema.String }),
]);
export type Answer = typeof Answer.Type;
export type ErrorAnswer = Extract<Answer, { type: "error" }>;

const decodeRequest = Schema.decodeUnknownSync(Request);
const decodeAnswer = Schema.decodeUnknownSync(Answer);
const isId = Schema.is(Id);

export const line = (message: Request | Answer): string => `${JSON.stringify(message)}\n`;

/** One line from a client: the request, or the error answer that the daemon sends back for it. */
export function readRequest(
  text: string,
): { ok: true; request: Request } | { ok: false; answer: ErrorAnswer } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, answer: { id: null, type: "error", error: "The line is not JSON." } };
  }
  try {
    return { ok: true, request: decodeRequest(value) };
  } catch (error) {
    const id =
      typeof value === "object" && value !== null && "id" in value && isId(value.id) ? value.id : null;
    return {
      ok: false,
      answer: {
        id,
        type: "error",
        error: `The request does not match K-702: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/** One line from the daemon. A line that does not match throws: the daemon and the client disagree. */
export const readAnswer = (text: string): Answer => decodeAnswer(JSON.parse(text));
