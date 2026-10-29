// K-1609, K-711: the link proxy. A provider reaches the address of a card on another machine through this machine's
// daemon, which adds the machine token. The provider never holds a Cloudflare credential. One server serves a Unix
// socket in the daemon's private folder, and a named pipe on Windows with the rules of K-621.
import { chmodSync, lstatSync, rmSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type Socket, connect as connectTcp } from "node:net";
import { Readable } from "node:stream";
import { connect as connectTls } from "node:tls";
import type { ReachedCard } from "@kitshn/local";
import type { Platform } from "./service.ts";
import { pipeServerProblem } from "./winpipe.ts";

/** The Access service token of this machine (K-107). */
export interface MachineToken {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** K-621: at most this many connections at once, and a request sends its headers within this time. */
const LINK_CONNECTIONS = 64;
const LINK_HEADERS_MS = 30_000;

/**
 * K-1609: where a request to `/<provider>/<machine id>/<path>` goes: the address of that provider's card on that
 * machine in this machine's reach. Known limit: with two addressed kinds of one provider on one machine, the first
 * card with an address wins; revisit when a provider has two, then the path names the card.
 */
export function linkTarget(
  reachOf: (provider: string) => ReadonlyArray<ReachedCard>,
  url: URL,
  scheme: "https" | "http" = "https",
): { readonly target: URL } | { readonly error: string; readonly status: number } {
  const [, provider = "", machineId = "", ...rest] = url.pathname.split("/");
  const address = reachOf(provider).find(
    (card) => card.machineId === machineId && card.address !== null,
  )?.address;
  if (!address)
    return {
      error: `the provider ${provider} of this machine reaches no address of the machine ${machineId} (K-1609).`,
      status: 403,
    };
  const target = new URL(`${scheme}://${address}/${rest.join("/")}${url.search}`);
  // A path cannot change the host: the proxy reaches only the card's own address.
  if (target.host !== address) return { error: `${url.pathname} leaves ${address}.`, status: 400 };
  return { target };
}

/** The cookies of a `Cookie` header without `CF_Authorization`, or null when none is left. */
export function withoutAccessCookie(cookie: string): string | null {
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.startsWith("CF_Authorization="));
  return kept.length > 0 ? kept.join("; ") : null;
}

/**
 * The headers that go on: never the caller's own Access headers or Access session cookie, nor the parts of a hop.
 * An Access session cookie would let B see a person or an old session instead of A's machine token.
 */
export function linkHeaders(rawHeaders: ReadonlyArray<string>, token: MachineToken): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const value = rawHeaders[index + 1]!;
    const lower = name.toLowerCase();
    if (lower.startsWith("cf-access-") || HOP_HEADERS.has(lower)) continue;
    if (lower === "cookie") {
      const kept = withoutAccessCookie(value);
      if (kept) headers.push([name, kept]);
      continue;
    }
    headers.push([name, value]);
  }
  headers.push(["CF-Access-Client-Id", token.clientId], ["CF-Access-Client-Secret", token.clientSecret]);
  return headers;
}

/** Headers of one hop, which each side of the proxy sets for itself. */
const HOP_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

/** Whether a `Set-Cookie` value sets the Access session, which never comes back through the proxy. */
const setsAccessSession = (cookie: string) => cookie.trimStart().startsWith("CF_Authorization=");

interface LinkOptions {
  readonly reachOf: (provider: string) => ReadonlyArray<ReachedCard>;
  readonly token: () => MachineToken | null;
  readonly log: (text: string) => void;
  /** `http` only in tests. */
  readonly scheme?: "https" | "http";
}

/**
 * K-1609: serves the link proxy on `path`: a Unix socket of mode 0600 in the daemon's private folder, or on Windows a
 * named pipe, which refuses remote clients and gives read and write only to its owner (K-621). HTTP streams both
 * ways; a WebSocket upgrade becomes a byte tunnel to the card's address, with the headers of the proxy.
 */
export function serveLinks(path: string, options: LinkOptions): Promise<{ readonly stop: () => void }> {
  const scheme = options.scheme ?? "https";
  const refuse = (response: ServerResponse, status: number, error: string) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error }));
  };
  const server = createServer((request, response) => void forward(request, response));
  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const found = linkTarget(options.reachOf, new URL(request.url ?? "/", "http://link"), scheme);
    if ("error" in found) return refuse(response, found.status, found.error);
    const token = options.token();
    if (!token) return refuse(response, 503, "the daemon has no machine token.");
    const method = request.method ?? "GET";
    try {
      const answer = await fetch(found.target, {
        method,
        headers: linkHeaders(request.rawHeaders, token),
        redirect: "manual",
        // The bytes go on as B sends them, so a compressed answer keeps its own encoding header.
        decompress: false,
        ...(method === "GET" || method === "HEAD"
          ? {}
          : { body: Readable.toWeb(request) as ReadableStream, duplex: "half" }),
      } as RequestInit);
      const headers: Array<[string, string]> = [];
      for (const [name, value] of answer.headers)
        if (name.toLowerCase() !== "set-cookie" && !HOP_HEADERS.has(name.toLowerCase()))
          headers.push([name, value]);
      for (const cookie of answer.headers.getSetCookie())
        if (!setsAccessSession(cookie)) headers.push(["set-cookie", cookie]);
      response.writeHead(answer.status, headers.flat());
      if (answer.body) for await (const chunk of answer.body) response.write(chunk);
      response.end();
    } catch (error) {
      options.log(`link: ${found.target.host} failed: ${String(error)}`);
      if (response.headersSent) response.destroy();
      else refuse(response, 502, "the link to the other machine failed.");
    }
  };
  server.on("upgrade", (request: IncomingMessage, client: Socket, head: Buffer) => {
    const found = linkTarget(options.reachOf, new URL(request.url ?? "/", "http://link"), scheme);
    const token = options.token();
    if ("error" in found || !token) {
      client.end(`HTTP/1.1 ${"error" in found ? found.status : 503} Refused\r\nConnection: close\r\n\r\n`);
      return;
    }
    const { target } = found;
    const port = Number(target.port || (scheme === "https" ? 443 : 80));
    const upstream =
      scheme === "https"
        ? connectTls({ host: target.hostname, port, servername: target.hostname })
        : connectTcp({ host: target.hostname, port });
    const ready = scheme === "https" ? "secureConnect" : "connect";
    upstream.once(ready, () => {
      const lines = [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        "Connection: Upgrade",
      ];
      for (const [name, value] of linkHeaders(request.rawHeaders, token)) lines.push(`${name}: ${value}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      tunnelAnswer(upstream, client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", (error: Error) => {
      options.log(`link: ${target.host} failed: ${String(error)}`);
      close();
    });
    client.on("error", close);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  server.maxConnections = LINK_CONNECTIONS;
  server.headersTimeout = LINK_HEADERS_MS;
  server.requestTimeout = 0;
  if (!path.startsWith("\\\\.\\pipe\\")) rmSync(path, { force: true });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`another program holds the link pipe ${path} (K-621); the daemon serves no links now.`)
          : error,
      ),
    );
    server.listen(path, () => {
      if (!path.startsWith("\\\\.\\pipe\\")) chmodSync(path, 0o600);
      resolve({ stop: () => void server.close() });
    });
  });
}

/**
 * The answer head of an upgrade goes back without the `Set-Cookie` of an Access session; the bytes after it go on as
 * they come.
 */
function tunnelAnswer(upstream: Socket, client: Socket) {
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    upstream.off("data", onData);
    const lines = head
      .subarray(0, end)
      .toString("latin1")
      .split("\r\n")
      .filter((line) => !(line.toLowerCase().startsWith("set-cookie:") && setsAccessSession(line.slice(11))));
    client.write(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"));
    const rest = head.subarray(end + 4);
    if (rest.length > 0) client.write(rest);
    upstream.pipe(client);
  };
  upstream.on("data", onData);
}

/**
 * K-1609, K-621: why a provider must not use the link socket `path`, or null. On Windows, the pipe's server must run as
 * this account; elsewhere, the socket must be this user's, with mode 0600.
 */
export function linkSocketProblem(platform: Platform, path: string): string | null {
  if (platform === "win32") {
    const problem = pipeServerProblem(path);
    return problem === "missing" ? `no link proxy serves ${path}.` : problem;
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket()) return `${path} is not a socket.`;
    if (stat.uid !== process.getuid!())
      return `${path} belongs to the user id ${stat.uid}, not to this user.`;
    if ((stat.mode & 0o777) !== 0o600)
      return `${path} has the mode ${(stat.mode & 0o777).toString(8)}, not 600.`;
    return null;
  } catch {
    return `no link proxy serves ${path}.`;
  }
}
