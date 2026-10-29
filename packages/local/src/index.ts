// K-702: the messages of the daemon's local socket (K-701). One JSON value per line. A request carries an id,
// its answer the same id. An event carries no id (K-703): the result of an ask that waited (K-1722).
import { Schema } from "effect";

/** The longest line, in UTF-16 code units, that the daemon reads; a longer line ends the connection. */
export const MAX_LINE_LENGTH = 64 * 1024;

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
  /** K-1762: `git credential erase` drops the kept tokens of one repo. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("forget-token"),
    repo: Schema.String.check(Schema.isMaxLength(512)),
  }),
  Ask,
]);
export type Request = typeof Request.Type;

export const Status = Schema.Struct({
  version: Schema.String,
  machineId: Schema.String,
  /** Null when this machine has no `machine.key` (K-1708). */
  fingerprint: Schema.NullOr(Schema.String),
  /** `token-only`: kitshn has no key for this machine and reads only its status (K-1708). */
  connection: Schema.Literals(["connected", "token-only", "disconnected"]),
  tunnel: Schema.Literals(["starting", "running", "stopped"]),
  /** K-1752: the variables whose values the commands send with an ask, for the attesters of this machine. */
  attesterEnv: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type Status = typeof Status.Type;

export const Answer = Schema.Union([
  Schema.Struct({ id: Id, type: Schema.Literal("status"), status: Status }),
  Schema.Struct({ id: Id, type: Schema.Literal("rotate-key"), fingerprint: Schema.String }),
  Schema.Struct({ id: Id, type: Schema.Literal("reconnect") }),
  Schema.Struct({ id: Id, type: Schema.Literal("forget-token") }),
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
