// K-619: the TCP ports that listen on this machine, with their process and one HTTP check, for the site wizard.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_SERVERS, type ServerReport } from "@kitshn/edge/sites";
import { type Platform, ownUid } from "./service.ts";

const run = promisify(execFile);

/** A listening port and its process, before the HTTP check. */
export interface Listener {
  readonly port: number;
  readonly process: string | null;
}

/** Processes that are kitshn's own plumbing, not servers that an owner shares. */
const OWN_PROCESSES: ReadonlySet<string> = new Set(["cloudflared", "kitshn", "kitshnd"]);

const portAfterColon = (address: string) => Number(address.slice(address.lastIndexOf(":") + 1));

/**
 * One entry per port, by port, at most MAX_SERVERS. A listener without a known process has no known owner, so it goes
 * (K-619: the scan reports only servers of the daemon's own user), and so do kitshn's own processes.
 */
function tidy(listeners: ReadonlyArray<Listener>): Array<Listener> {
  const byPort = new Map<number, Listener>();
  for (const listener of listeners) {
    if (!Number.isInteger(listener.port) || listener.port <= 0 || listener.port > 65535) continue;
    if (listener.process === null || OWN_PROCESSES.has(listener.process)) continue;
    if (!byPort.has(listener.port)) byPort.set(listener.port, listener);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port).slice(0, MAX_SERVERS);
}

/** macOS: the output of `lsof -nP -iTCP -sTCP:LISTEN -Fcn`, a `c<name>` line before the `n<address>` lines of each process. */
export function parseLsof(output: string): Array<Listener> {
  const listeners: Array<Listener> = [];
  let process: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) process = null;
    else if (line.startsWith("c")) process = line.slice(1) || null;
    else if (line.startsWith("n")) listeners.push({ port: portAfterColon(line.slice(1)), process });
  }
  return tidy(listeners);
}

/**
 * Linux: the output of `ss -ltnpeH`; the process shows as `users:(("name",pid=1,fd=3))`, and `uid:<n>` names the
 * owner. Only listeners of `uid` count.
 */
export function parseSs(output: string, uid: number): Array<Listener> {
  const listeners: Array<Listener> = [];
  for (const line of output.split("\n")) {
    const fields = line.split(" ").filter((field) => field !== "");
    const local = fields[3];
    // `ss -e` prints no `uid:` for root's own sockets, so a root daemon takes the lines without one.
    const owner = fields.find((field) => field.startsWith("uid:"));
    if (fields[0] !== "LISTEN" || !local || owner !== (uid === 0 ? undefined : `uid:${uid}`)) continue;
    const users = fields.slice(5).join(" ");
    const start = users.indexOf('(("');
    const end = start < 0 ? -1 : users.indexOf('"', start + 3);
    listeners.push({
      port: portAfterColon(local),
      process: end < 0 ? null : users.slice(start + 3, end) || null,
    });
  }
  return tidy(listeners);
}

/** The text of the first `<title>` in `html`, trimmed to 80 characters, or null. */
export function titleOf(html: string): string | null {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  const start = open < 0 ? -1 : lower.indexOf(">", open) + 1;
  const end = start <= 0 ? -1 : lower.indexOf("</title>", start);
  if (end < 0) return null;
  const title = html
    .slice(start, end)
    .split("\n")
    .map((part) => part.trim())
    .join(" ")
    .trim();
  return title === "" ? null : title.slice(0, 80);
}

/** One `GET /` with a 2-second timeout, at most 64 KB read. */
/** At most this many bytes of a page are read for its title. */
const PAGE_BYTES = 64 * 1024;

/**
 * One `GET /` with a 2-second deadline for the whole check, at most PAGE_BYTES read. A server bound to IPv6 only gets
 * the same GET on `[::1]` when `127.0.0.1` refuses.
 */
async function check(port: number): Promise<Pick<ServerReport, "status" | "title">> {
  const signal = AbortSignal.timeout(2_000);
  for (const host of ["127.0.0.1", "[::1]"]) {
    let response: Response;
    try {
      response = await fetch(`http://${host}:${port}/`, {
        redirect: "manual",
        signal,
        headers: { host: "localhost" },
      });
    } catch {
      if (signal.aborted) break;
      continue;
    }
    try {
      return { status: response.status, title: titleOf(await firstBytes(response, PAGE_BYTES)) };
    } catch {
      return { status: response.status, title: null };
    }
  }
  return { status: null, title: null };
}

/** The text of the first `limit` bytes of a body; it decodes only the bytes within the limit, then stops reading. */
export async function firstBytes(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let left = limit;
  try {
    while (left > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.byteLength > left ? value.subarray(0, left) : value;
      left -= part.byteLength;
      text += decoder.decode(part, { stream: left > 0 });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * K-619: the listening ports of the daemon's own user now. Known limit: Windows has no scan in the first version
 * (K-624), so its list stays empty; revisit with `Get-NetTCPConnection` when owners add sites from Windows.
 */
export async function listeners(platform: Platform): Promise<Array<Listener>> {
  if (platform === "win32") return [];
  try {
    if (platform === "darwin") {
      const { stdout } = await run(
        "lsof",
        ["-nP", "-a", "-u", String(ownUid()), "-iTCP", "-sTCP:LISTEN", "-Fcn"],
        {
          timeout: 5_000,
        },
      );
      return parseLsof(stdout);
    }
    const { stdout } = await run("ss", ["-ltnpeH"], { timeout: 5_000 });
    return parseSs(stdout, ownUid());
  } catch (error) {
    // lsof exits with 1 when nothing listens.
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" && platform === "darwin" ? parseLsof(stdout) : [];
  }
}

/**
 * K-619: the report of the listening ports. A port that `known` has with the same process keeps its check, so a scan
 * checks only new servers; `recheck` checks all of them again.
 */
export async function scanServers(
  platform: Platform,
  known: ReadonlyArray<ServerReport>,
  recheck: boolean,
): Promise<Array<ServerReport>> {
  const now = await listeners(platform);
  return Promise.all(
    now.map(async (listener) => {
      const old = known.find(
        (server) => server.port === listener.port && server.process === listener.process,
      );
      return old && !recheck ? old : { ...listener, ...(await check(listener.port)) };
    }),
  );
}
