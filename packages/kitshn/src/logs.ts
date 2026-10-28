// K-1809: the time range and the output of `kitshn logs`.

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `15m`, `1h`, `2d`: the time back from now; null for any other text. */
export function sinceMs(text: string): number | null {
  const unit = text.slice(-1);
  const count = Number(text.slice(0, -1));
  if (!(unit in UNITS) || !Number.isSafeInteger(count) || count <= 0) return null;
  return count * UNITS[unit as keyof typeof UNITS];
}

/** The search range: `--since`, or `--from` with an optional `--to`; the default is the last hour. */
export function logRange(
  options: { readonly since: string; readonly from: string; readonly to: string },
  now: number,
): { readonly from: number; readonly to: number } | string {
  if (options.from === "" && options.to !== "") return "--to needs --from.";
  if (options.from !== "") {
    if (options.since !== "") return "use --since or --from, not both.";
    const from = Date.parse(options.from);
    const to = options.to === "" ? now : Date.parse(options.to);
    if (Number.isNaN(from) || Number.isNaN(to))
      return "--from and --to take a time such as 2026-10-28T14:00:00Z.";
    return from < to ? { from, to } : "--from must come before --to.";
  }
  const back = sinceMs(options.since === "" ? "1h" : options.since);
  return back === null
    ? "--since takes a number and m, h or d, such as 15m, 1h or 2d."
    : { from: now - back, to: now };
}

/** One log line as the CLI prints it. */
export const logLineText = (line: { readonly at: number; readonly source: string; readonly text: string }) =>
  `${new Date(line.at).toISOString()} ${line.source} ${line.text}`;

/** K-1801: the answer of a search, as `/agent/logs` sends it. */
export type LogAnswer =
  | {
      readonly state: "lines";
      readonly lines: ReadonlyArray<{ readonly at: number; readonly source: string; readonly text: string }>;
      readonly matched: number;
      readonly cut: boolean;
    }
  | { readonly state: "error"; readonly error: string }
  | { readonly state: "needs-permission" };

/** K-1808: one deploy run, as `/agent/logs` sends it for `--deploys`. */
export interface DeployRun {
  readonly at: number;
  readonly sha: string;
  readonly state: string;
  readonly reason: string | null;
  readonly runUrl: string | null;
  readonly lines: ReadonlyArray<string> | null;
}

/** The card and the search text; `--` ends the flags, so the text can start with `--`. */
export function logArgs(args: ReadonlyArray<string>): {
  readonly card: string | undefined;
  readonly text: string;
} {
  const end = args.indexOf("--");
  const flags = end < 0 ? args : args.slice(0, end);
  const valued = new Set(["--since", "--from", "--to", "--server"]);
  const named = flags.filter((arg, index) => !arg.startsWith("--") && !valued.has(flags[index - 1] ?? ""));
  const [card, ...words] = [...named, ...(end < 0 ? [] : args.slice(end + 1))];
  return { card, text: words.join(" ") };
}
