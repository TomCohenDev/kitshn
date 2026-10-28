// K-1804, K-1805: search and follow the logs of a Compose app through `docker compose logs`.
import {
  LOG_LINES,
  type LogAnswer,
  type LogLine,
  type LogSearch,
  Newest,
  TAIL_BATCH,
  TAIL_MS,
  matchesText,
  parseComposeLine,
} from "@kitshn/edge/logs";
import { type ChildProcess, spawn } from "node:child_process";

/** K-1804: kitshn waits 20 seconds for an answer, so the daemon stops its search a little earlier. */
const SEARCH_MS = 15_000;

/** The program and its arguments; a test passes another program. */
export type Program = readonly [string, ReadonlyArray<string>];

export const composeLogs = (project: string, args: ReadonlyArray<string>): Program => [
  "docker",
  ["compose", "-p", project, "logs", "--timestamps", "--no-color", ...args],
];

/** Calls `onLine` for each whole line of the output, and keeps the end of the error output. */
function run(program: Program, cwd: string, onLine: (line: string) => void) {
  // Its own group, so a stop also ends what Compose started.
  const child = spawn(program[0], [...program[1]], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd,
  });
  let rest = "";
  let errors = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const parts = (rest + chunk.toString("utf8")).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) onLine(part);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString("utf8")).slice(-2000);
  });
  const ended = new Promise<string | null>((resolve) => {
    child.on("close", (code) => {
      if (rest !== "") onLine(rest);
      resolve(code === 0 ? null : `docker compose logs ended with ${String(code)}: ${errors.trim()}`);
    });
    child.on("error", (error) => resolve(String(error)));
  });
  return { child, ended };
}

function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The group is gone already.
  }
}

/**
 * K-1804: the newest lines that match. Compose writes each container in time order, but mixes the
 * containers as they come, so each source keeps its own newest lines before they merge.
 */
export async function searchLogs(program: Program, search: LogSearch, cwd: string): Promise<LogAnswer> {
  const sources = new Map<string, Newest<LogLine>>();
  let matched = 0;
  const { child, ended } = run(program, cwd, (raw) => {
    const line = parseComposeLine(raw);
    if (!line || line.at < search.from || line.at > search.to) return;
    if (!matchesText(`${line.source} ${line.text}`, search.text)) return;
    matched++;
    let newest = sources.get(line.source);
    if (!newest) sources.set(line.source, (newest = new Newest(LOG_LINES)));
    newest.add(line);
  });
  const timer = setTimeout(() => stop(child), SEARCH_MS);
  const error = await ended;
  clearTimeout(timer);
  if (error !== null && child.signalCode === null) return { state: "error", error };
  const lines = [...sources.values()]
    .flatMap((newest) => newest.items)
    .sort((a, b) => a.at - b.at)
    .slice(-LOG_LINES);
  return { state: "lines", lines, matched };
}

/** `since` and `until` for a search; Docker reads RFC 3339. */
export const rangeArgs = (search: LogSearch) => [
  "--since",
  new Date(search.from).toISOString(),
  "--until",
  new Date(search.to).toISOString(),
];

/**
 * K-1805: follows the logs and sends new lines at most once a second, at most `TAIL_BATCH` at a time. Ends by
 * itself after 30 minutes. The returned function stops it; `onEnd` then does not run.
 */
export function followLogs(
  program: Program,
  cwd: string,
  onLines: (lines: ReadonlyArray<LogLine>, skipped: number) => void,
  onEnd: (reason: string) => void,
): () => void {
  let batch = new Newest<LogLine>(TAIL_BATCH);
  let stopped = false;
  const { child, ended } = run(program, cwd, (raw) => {
    const line = parseComposeLine(raw);
    if (line) batch.add(line);
  });
  const flush = () => {
    if (batch.count === 0) return;
    onLines(batch.items, batch.count - batch.items.length);
    batch = new Newest(TAIL_BATCH);
  };
  const tick = setInterval(flush, 1000);
  const end = (reason: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
    clearTimeout(limit);
    stop(child);
    flush();
    onEnd(reason);
  };
  const limit = setTimeout(() => end("Live stops after 30 minutes (K-1805)."), TAIL_MS);
  void ended.then((error) => end(error ?? "docker compose logs ended."));
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
    clearTimeout(limit);
    stop(child);
  };
}

/** K-1803: at most 30 MB of logs per container. */
export const LOG_LIMITS = { driver: "local", options: { "max-size": "10m", "max-file": "3" } } as const;

/**
 * K-1803: the checked Compose config with the log limits on each service. A driver other than `json-file` or
 * `local` passed the check of K-818 only because the owner allows it, so it stays.
 */
export function withLogLimits(config: unknown): unknown {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return config;
  const services = (config as { services?: unknown }).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return config;
  return {
    ...config,
    services: Object.fromEntries(
      Object.entries(services as Record<string, Record<string, unknown>>).map(([name, service]) => {
        const driver = (service["logging"] as { driver?: unknown } | undefined)?.driver;
        const own = driver !== undefined && driver !== "json-file" && driver !== "local";
        return [name, own ? service : { ...service, logging: LOG_LIMITS }];
      }),
    ),
  };
}
