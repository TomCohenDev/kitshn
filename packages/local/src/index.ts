// K-702: the messages of the daemon's local socket (K-701). One JSON value per line. A request carries an id,
// its answer the same id. An event carries no id (none yet; K-703 adds them).
import { Schema } from "effect";

/** The longest line, in UTF-16 code units, that the daemon reads; a longer line ends the connection. */
export const MAX_LINE_LENGTH = 64 * 1024;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const Request = Schema.Union([
  /** The machine id, the key fingerprint, the connection to kitshn and the tunnel service (K-605). */
  Schema.Struct({ id: Id, type: Schema.Literal("status") }),
  /** K-1705: rotate the machine key over the live connection. */
  Schema.Struct({ id: Id, type: Schema.Literal("rotate-key") }),
  /** K-1706: `kitshn rekey` saved a new key; connect again with it. */
  Schema.Struct({ id: Id, type: Schema.Literal("reconnect") }),
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
});
export type Status = typeof Status.Type;

export const Answer = Schema.Union([
  Schema.Struct({ id: Id, type: Schema.Literal("status"), status: Status }),
  Schema.Struct({ id: Id, type: Schema.Literal("rotate-key"), fingerprint: Schema.String }),
  Schema.Struct({ id: Id, type: Schema.Literal("reconnect") }),
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
export function readRequest(text: string): { ok: true; request: Request } | { ok: false; answer: ErrorAnswer } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, answer: { id: null, type: "error", error: "The line is not JSON." } };
  }
  try {
    return { ok: true, request: decodeRequest(value) };
  } catch (error) {
    const id = typeof value === "object" && value !== null && "id" in value && isId(value.id) ? value.id : null;
    return { ok: false, answer: { id, type: "error", error: `The request does not match K-702: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

/** One line from the daemon. A line that does not match throws: the daemon and the client disagree. */
export const readAnswer = (text: string): Answer => decodeAnswer(JSON.parse(text));
