// K-630, K-631: the health grid of the machines, from the last report of each daemon, and what it opens.
import type { HealthReport } from "@kitshn/local";
import type { NotificationInput } from "./notifications.ts";

/** K-631: a report older than two and a half checks (K-630) is unknown. A value of `@kitshn/local` would pull `effect` into the UI. */
export const HEALTH_STALE_MS = 25 * 60_000;
/** K-631: a check that fails this many times in a row opens a notification. */
export const HEALTH_NOTIFY_AFTER = 2;

/** What the grid needs of one machine; the map has it in `MachineView`. */
export interface HealthMachine {
  readonly machine: { readonly id: string; readonly name: string };
  readonly online: boolean;
  readonly health: HealthReport | null;
}

/**
 * K-631: one cell. `none`: the row machine has no link to the column machine; `unknown`: its daemon is offline, sent no
 * report yet, or sent the last one more than 25 minutes ago. The diagonal cell is the providers of the machine.
 */
export type HealthCell =
  | { readonly state: "none" }
  | { readonly state: "unknown"; readonly at: number | null }
  | { readonly state: "ok" | "bad"; readonly at: number; readonly errors: ReadonlyArray<string> };

export function healthCell(from: HealthMachine, toId: string, now: number): HealthCell {
  const report = from.health;
  if (!from.online || report === null || now - report.at > HEALTH_STALE_MS)
    return { state: "unknown", at: report?.at ?? null };
  const checks =
    toId === from.machine.id
      ? report.providers.map((check) => ({ ...check, name: `provider ${check.provider}` }))
      : report.links
          .filter((link) => link.machineId === toId)
          .map((link) => ({ ...link, name: `link ${link.provider}` }));
  if (checks.length === 0) return { state: "none" };
  const errors = checks.flatMap((check) => (check.error === null ? [] : [`${check.name}: ${check.error}`]));
  return { state: errors.length > 0 ? "bad" : "ok", at: report.at, errors };
}

/** K-631: the red link cells of a machine's row and column, for the sticker of its card; an offline provider has its own (K-515). */
export function healthProblems(
  machines: ReadonlyArray<HealthMachine>,
  machineId: string,
  now: number,
): Array<string> {
  const self = machines.find((view) => view.machine.id === machineId);
  if (!self) return [];
  const problems: Array<string> = [];
  for (const other of machines) {
    if (other === self) continue;
    const outgoing = healthCell(self, other.machine.id, now);
    if (outgoing.state === "bad")
      problems.push(`${self.machine.name} → ${other.machine.name}: ${outgoing.errors.join("; ")}`);
    const incoming = healthCell(other, machineId, now);
    if (incoming.state === "bad")
      problems.push(`${other.machine.name} → ${self.machine.name}: ${incoming.errors.join("; ")}`);
  }
  return problems;
}

/**
 * K-631: the `health` notifications of one machine's report: a link check that failed `HEALTH_NOTIFY_AFTER` times in a
 * row. A link to an offline machine opens none, because the `machine` notification of K-1910 says that already, and an
 * offline provider has its own `provider` notification (K-704). Each key that is not in the list closes, so a check
 * that passes, or that the report no longer names, ends its notification.
 */
export function healthNotices(
  machine: { readonly id: string; readonly name: string },
  report: HealthReport,
  others: ReadonlyMap<string, { readonly name: string; readonly online: boolean }>,
): Array<NotificationInput> {
  const notice = (key: string, since: number | null, title: string, text: string): NotificationInput => ({
    source: "health",
    key: `${machine.id}:${key}`,
    episode: String(since),
    card: machine.id,
    recipients: { _tag: "owner" },
    level: "error",
    priority: "normal",
    title,
    text,
    actions: [{ id: "show", label: "Show machines", kind: "link", path: "#machines" }],
  });
  const links = report.links.flatMap((check) => {
    const target = others.get(check.machineId);
    if (check.failures < HEALTH_NOTIFY_AFTER || target?.online === false) return [];
    const name = target?.name ?? check.machineId;
    return [
      notice(
        `link:${check.provider}:${check.machineId}`,
        check.since,
        `${machine.name} cannot reach ${name} (${check.provider})`,
        `${check.failures} checks in a row failed. ${check.error ?? ""}`,
      ),
    ];
  });
  return links;
}
