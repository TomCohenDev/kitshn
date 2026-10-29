// K-1609, K-711: the link proxy. A provider reaches the address of a card on another machine through this machine's
// daemon, which adds the machine token. The provider never holds a Cloudflare credential.
import { chmodSync, rmSync } from "node:fs";
import type { ReachedCard } from "@kitshn/local";

/** The Access service token of this machine (K-107). */
export interface MachineToken {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * K-1609: where a request to `/<machine id>/<path>` goes: the address of a card of that machine that this machine
 * reaches. Known limit: the reach of every provider of this machine counts, and with several such cards the first
 * with an address wins, also a card of another provider. Revisit when a second provider, or a second addressed kind,
 * has cards on the same machine: then the path names the card.
 */
export function linkTarget(
  reach: ReadonlyArray<ReachedCard>,
  url: URL,
  scheme: "https" | "http" = "https",
): { readonly target: URL } | { readonly error: string; readonly status: number } {
  const [, machineId = "", ...rest] = url.pathname.split("/");
  const address = reach.find((card) => card.machineId === machineId && card.address !== null)?.address;
  if (!address)
    return { error: `this machine reaches no address of the machine ${machineId} (K-1609).`, status: 403 };
  const target = new URL(`${scheme}://${address}/${rest.join("/")}${url.search}`);
  // A path cannot change the host: the proxy reaches only the card's own address.
  if (target.host !== address) return { error: `${url.pathname} leaves ${address}.`, status: 400 };
  return { target };
}

/** The headers that go on: never the caller's own Access headers, nor the parts of a WebSocket handshake. */
export function linkHeaders(incoming: Headers, token: MachineToken): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    if (lower.startsWith("cf-access-") || lower.startsWith("sec-websocket-")) continue;
    if (["host", "connection", "upgrade", "content-length"].includes(lower)) continue;
    // An Access session cookie would let B see a person or an old session instead of A's machine token.
    if (lower === "cookie") {
      const kept = withoutAccessCookie(value);
      if (kept) headers[name] = kept;
      continue;
    }
    headers[name] = value;
  }
  headers["CF-Access-Client-Id"] = token.clientId;
  headers["CF-Access-Client-Secret"] = token.clientSecret;
  return headers;
}

/** The cookies of a `Cookie` header without `CF_Authorization`, or null when none is left. */
export function withoutAccessCookie(cookie: string): string | null {
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.startsWith("CF_Authorization="));
  return kept.length > 0 ? kept.join("; ") : null;
}

/** An answer without the `Set-Cookie` of an Access session, so the caller never keeps B's session. */
function withoutAccessSetCookie(answer: Response): Response {
  const cookies = answer.headers.getSetCookie();
  if (!cookies.some((cookie) => cookie.startsWith("CF_Authorization="))) return answer;
  const headers = new Headers(answer.headers);
  headers.delete("set-cookie");
  for (const cookie of cookies)
    if (!cookie.startsWith("CF_Authorization=")) headers.append("set-cookie", cookie);
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

interface Upstream {
  readonly target: string;
  readonly headers: Record<string, string>;
  socket: WebSocket | null;
  readonly pending: Array<string | ArrayBuffer | Uint8Array>;
}

/**
 * K-1609: serves the link proxy on a Unix socket in the daemon's private folder (mode 0600 in 0700), so only the daemon
 * user and root reach it (K-701). HTTP and WebSocket requests stream both ways. `scheme` is `http` only in tests.
 */
export function serveLinks(
  path: string,
  options: {
    readonly reach: () => ReadonlyArray<ReachedCard>;
    readonly token: () => MachineToken | null;
    readonly log: (text: string) => void;
    readonly scheme?: "https" | "http";
  },
): { readonly stop: () => void } {
  rmSync(path, { force: true });
  const server = Bun.serve<Upstream>({
    unix: path,
    fetch(request, server) {
      const found = linkTarget(options.reach(), new URL(request.url), options.scheme);
      if ("error" in found) return Response.json({ error: found.error }, { status: found.status });
      const token = options.token();
      if (!token) return Response.json({ error: "the daemon has no machine token." }, { status: 503 });
      const headers = linkHeaders(request.headers, token);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const target = new URL(found.target);
        target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        const upgraded = server.upgrade(request, {
          data: { target: target.toString(), headers, socket: null, pending: [] },
        });
        return upgraded
          ? undefined
          : Response.json({ error: "the WebSocket upgrade failed." }, { status: 400 });
      }
      return fetch(found.target, {
        method: request.method,
        headers,
        redirect: "manual",
        ...(request.body ? { body: request.body, duplex: "half" } : {}),
      } as RequestInit).then(withoutAccessSetCookie);
    },
    websocket: {
      open(client) {
        const upstream = new WebSocket(client.data.target, {
          headers: client.data.headers,
        } as unknown as string[]);
        upstream.binaryType = "arraybuffer";
        client.data.socket = upstream;
        upstream.onopen = () => {
          for (const message of client.data.pending.splice(0)) upstream.send(message);
        };
        upstream.onmessage = (event) => client.send(event.data as string | ArrayBuffer);
        // 1005 and 1006 are reserved and cannot be sent; such a close ends the client plainly.
        upstream.onclose = (event) =>
          event.code === 1005 || event.code === 1006
            ? client.close()
            : client.close(event.code, event.reason);
        upstream.onerror = () => {
          options.log(`link: ${new URL(client.data.target).host} failed`);
          client.close(1011, "the link to the other machine failed");
        };
      },
      message(client, message) {
        const upstream = client.data.socket;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
        else client.data.pending.push(message);
      },
      close(client) {
        client.data.socket?.close();
      },
    },
  });
  chmodSync(path, 0o600);
  return { stop: () => server.stop(true) };
}
