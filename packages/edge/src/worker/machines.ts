import type { Command, Machine } from "../core/machine.ts";
import type { JobView } from "../core/protocol.ts";

/** K-613: a job waits at most this long for its machine by default. */
export const JOB_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** K-1107: a machine that answered no ping for this long counts as offline. */
export const PING_TIMEOUT_MS = 30_000;
/** K-602 */
export const JOIN_CODE_MS = 10 * 60 * 1000;
/** Job output that kitshn keeps, at most. The daemon caps it too. */
export const OUTPUT_LIMIT = 64 * 1024;

export type Job = JobView;

/** K-610: the first online machine in the owner's order that has every label, or null. */
export function pickMachine(
  machines: Iterable<Machine>,
  online: ReadonlySet<string>,
  labels: ReadonlyArray<string>,
): Machine | null {
  const fitting = [...machines]
    .filter((machine) => online.has(machine.id) && labels.every((label) => machine.labels.includes(label)))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return fitting[0] ?? null;
}

const LABEL = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function parseLabels(value: unknown): Array<string> | string {
  if (!Array.isArray(value)) return "Labels must be a list.";
  const labels = value.map((label) => String(label).trim().toLowerCase()).filter(Boolean);
  const bad = labels.find((label) => !LABEL.test(label));
  return bad ? `The label "${bad}" may use only a to z, 0 to 9 and dashes.` : [...new Set(labels)];
}

export function parseCommand(value: unknown): Command | string {
  if (typeof value !== "object" || value === null || !("kind" in value)) return "A job needs a command.";
  if (value.kind === "diagnostics" || value.kind === "restart") return { kind: value.kind };
  if (value.kind === "shell") {
    const script = "script" in value ? value.script : undefined;
    if (typeof script !== "string" || !script.trim() || script.length > 10_000) {
      return "A shell command needs a script of 1 to 10,000 characters.";
    }
    return { kind: "shell", script };
  }
  return `kitshn has no command "${String(value.kind)}".`;
}

/** A machine id from its name: lowercase, dashes, and a random tail so two machines never collide. */
export function machineIdFor(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const tail = crypto.randomUUID().slice(0, 6);
  return base ? `${base}-${tail}` : `machine-${tail}`;
}
