// K-1610: both machines report each call between them, and History pairs the two reports. A source that misbehaves can
// skip its own report, so an entry of one side without the other is marked.

export type AuditSide = "source" | "target";
export type AuditOutcome = "succeeded" | "refused" | "failed";

/** One stored report: `source` and `target` are machine ids, whichever machine reported it. */
export interface LinkReport {
  readonly id: number;
  readonly at: number;
  readonly side: AuditSide;
  readonly source: string;
  readonly target: string;
  readonly kind: "exec" | "tool";
  readonly thread: string | null;
  readonly name: string;
  readonly cwd: string | null;
  readonly outcome: AuditOutcome;
  readonly exitCode: number | null;
}

/**
 * K-1610: "paired" when both sides reported, "no target report" or "no source report" when one side is missing after
 * the pairing window, and "waiting" while the other report can still come.
 */
export type LinkCheck = "paired" | "no target report" | "no source report" | "waiting";

export interface PairedReport {
  /** The source report, or the target report when the source sent none. */
  readonly report: LinkReport;
  /** The report of the other side, when it came. */
  readonly partner: LinkReport | null;
  readonly check: LinkCheck;
}

/**
 * The two reports of one call arrive within this time of each other: a call ends at most 90 seconds after it starts
 * (MM-1908), and each side reports when it ends. Revisit if calls get longer.
 */
export const PAIR_WINDOW_MS = 2 * 60_000;

/** One source report and one target report pair when they name the same machines, kind and tool, close in time. */
const pairs = (source: LinkReport, target: LinkReport) =>
  source.source === target.source &&
  source.target === target.target &&
  source.kind === target.kind &&
  (source.kind === "exec" || source.name === target.name) &&
  Math.abs(source.at - target.at) <= PAIR_WINDOW_MS;

/** K-1610: pairs the reports one to one, the oldest first, and returns them newest first. */
export function pairLinkReports(reports: ReadonlyArray<LinkReport>, now: number): Array<PairedReport> {
  const ordered = [...reports].sort((a, b) => a.at - b.at || a.id - b.id);
  const used = new Set<number>();
  const paired: Array<PairedReport> = [];
  const late = (report: LinkReport) => now - report.at > PAIR_WINDOW_MS;
  for (const source of ordered.filter((report) => report.side === "source")) {
    const target = ordered.find(
      (report) => report.side === "target" && !used.has(report.id) && pairs(source, report),
    );
    if (target) used.add(target.id);
    paired.push({
      report: source,
      partner: target ?? null,
      check: target ? "paired" : late(source) ? "no target report" : "waiting",
    });
  }
  for (const target of ordered.filter((report) => report.side === "target" && !used.has(report.id)))
    paired.push({ report: target, partner: null, check: late(target) ? "no source report" : "waiting" });
  return paired.sort((a, b) => b.report.at - a.report.at || b.report.id - a.report.id);
}
