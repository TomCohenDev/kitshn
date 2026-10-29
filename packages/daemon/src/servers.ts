// K-619: the TCP ports that listen on this machine, with their process and one HTTP check, for the site wizard.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_SERVERS, type ServerReport } from "@kitshn/edge/sites";

const run = promisify(execFile);

/** A listening port and its process, before the HTTP check. */
export interface Listener {
  readonly port: number;
  readonly process: string | null;
}

/** Processes that are kitshn's own plumbing, not servers that an owner shares. */
const OWN_PROCESSES: ReadonlySet<string> = new Set(["cloudflared", "kitshn", "kitshnd"]);

const portAfterColon = (address: string) => Number(address.slice(address.lastIndexOf(":") + 1));

/** One entry per port, the first process that names it, kitshn's own left out, by port, at most MAX_SERVERS. */
function tidy(listeners: ReadonlyArray<Listener>): Array<Listener> {
  const byPort = new Map<number, Listener>();
  for (const listener of listeners) {
    if (!Number.isInteger(listener.port) || listener.port <= 0 || listener.port > 65535) continue;
    if (listener.process !== null && OWN_PROCESSES.has(listener.process)) continue;
    const known = byPort.get(listener.port);
    if (!known || (known.process === null && listener.process !== null)) byPort.set(listener.port, listener);
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

/** Linux: the output of `ss -ltnpH`; the process shows as `users:(("name",pid=1,fd=3))` when this user owns it. */
export function parseSs(output: string): Array<Listener> {
  const listeners: Array<Listener> = [];
  for (const line of output.split("\n")) {
    const fields = line.split(" ").filter((field) => field !== "");
    const local = fields[3];
    if (fields[0] !== "LISTEN" || !local) continue;
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
async function check(port: number): Promise<Pick<ServerReport, "status" | "title">> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
      headers: { host: "localhost" },
    });
    const reader = response.body?.getReader();
    let html = "";
    const decoder = new TextDecoder();
    while (reader && html.length < 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    await reader?.cancel().catch(() => undefined);
    return { status: response.status, title: titleOf(html) };
  } catch {
    return { status: null, title: null };
  }
}

/** The listening ports now. Known limit: a scan sees only the processes of this user; others show without a name. */
export async function listeners(platform: "darwin" | "linux"): Promise<Array<Listener>> {
  try {
    if (platform === "darwin") {
      const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"], { timeout: 5_000 });
      return parseLsof(stdout);
    }
    const { stdout } = await run("ss", ["-ltnpH"], { timeout: 5_000 });
    return parseSs(stdout);
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
  platform: "darwin" | "linux",
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
