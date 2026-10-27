import { callerOf, deployerOf } from "./auth.ts";
import { escapeHtml, originDown, seenText } from "./live.ts";
import type { Env } from "./env.ts";

export { Kitshn } from "./kitshn.ts";

/**
 * K-1106 to K-1110: the Worker runs on a live site only while kitshn has an offline route on it. It asks
 * the origin first, so a site that came back works at once, and answers with the offline page only
 * when the origin is down.
 */
async function offline(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const origin = await fetch(request).catch(() => null);
  if (origin && !originDown(origin.status)) return origin;
  const cache = caches.default;
  const key = new Request(`https://kitshn-offline.internal/${url.hostname}`);
  let info = (await cache.match(key)?.then((response) => response?.json())) as OfflineInfo | undefined;
  if (!info) {
    const answer = await env.KITSHN.getByName("kitshn").fetch(
      `https://kitshn.internal/internal/offline?address=${encodeURIComponent(url.hostname)}`,
    );
    if (!answer.ok) return origin ?? new Response("The site is not reachable.", { status: 502 });
    info = (await answer.json()) as OfflineInfo;
    // K-1110: the name and the last seen time stay 60 seconds in the Cache API.
    ctx.waitUntil(
      cache.put(key, new Response(JSON.stringify(info), { headers: { "cache-control": "max-age=60" } })),
    );
  }
  const page = await env.ASSETS.fetch(new Request(new URL("/offline.html", `https://${env.KITSHN_HOST}`)));
  const html = (await page.text())
    .replaceAll("{{site}}", escapeHtml(info.site))
    .replaceAll("{{reason}}", escapeHtml(info.reason))
    .replaceAll("{{seen}}", escapeHtml(seenText(info.seen, Date.now())));
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60", "cache-control": "no-store" },
  });
}

interface OfflineInfo {
  readonly site: string;
  readonly reason: string;
  readonly seen: number | null;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== env.KITSHN_HOST && url.hostname.endsWith(`.${env.KITSHN_ZONE}`)) {
      return offline(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) {
      // A browser sends Origin on a WebSocket and a cross-site POST. Only the map's own page may call.
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== url.origin) {
        return Response.json({ error: `kitshn refuses requests from ${origin}.` }, { status: 403 });
      }
      if (request.method === "POST" && !request.headers.get("content-type")?.startsWith("application/json")) {
        return Response.json({ error: "Send JSON with Content-Type: application/json." }, { status: 415 });
      }
      const caller = await callerOf(request, env, env.ACCESS_ADMIN_AUD);
      if (typeof caller === "string") return Response.json({ error: caller }, { status: 401 });
      const headers = new Headers(request.headers);
      headers.set("x-kitshn-caller", JSON.stringify(caller));
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    if (url.pathname === "/connect") {
      // K-604: a daemon, with its machine's service token. Access checked it; the Worker checks the JWT.
      const caller = await callerOf(request, env, env.ACCESS_CONNECT_AUD);
      if (typeof caller === "string") return Response.json({ error: caller }, { status: 401 });
      if (caller.visitor.clientId === null) {
        return Response.json({ error: "Only a machine's service token can connect." }, { status: 403 });
      }
      const headers = new Headers(request.headers);
      headers.set("x-kitshn-caller", JSON.stringify(caller));
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    // K-617: the release that machines and deploy workflows download. Both paths are public in Access.
    if (
      (url.pathname === "/join/version" || url.pathname === "/deploy/version") &&
      request.method === "GET"
    ) {
      return new Response(`${env.KITSHN_VERSION}\n`, {
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/deploy/") && request.method === "POST") {
      // K-811: GitHub Actions deploys here with its OIDC token; Access lets the path through.
      const deployer = await deployerOf(request, env);
      if (typeof deployer === "string") return Response.json({ error: deployer }, { status: 401 });
      const headers = new Headers(request.headers);
      headers.delete("x-kitshn-caller");
      headers.set("x-kitshn-deployer", JSON.stringify(deployer));
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    if (url.pathname === "/join/exchange" && request.method === "POST") {
      // A cheap shape check keeps junk away from the Durable Object; the code itself is the secret.
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { code?: unknown } | null;
      if (typeof body?.code !== "string" || !/^[23456789abcdefghjkmnpqrstuvwxyz]{20}$/.test(body.code)) {
        return Response.json({ error: "This is not a kitshn join code." }, { status: 400 });
      }
      // K-602: public; the one-time join code is the secret. The Durable Object ignores any caller header.
      const headers = new Headers(request.headers);
      headers.delete("x-kitshn-caller");
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
