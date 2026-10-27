import {
  contentSecurityPolicy,
  type LibraryItem,
  isLibraryId,
  loginStep,
  objectKey,
} from "../core/library.ts";
import { type ContentLogins, callerOf, contentVisitorOf, cookieValues, deployerOf } from "./auth.ts";
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

/** What the Durable Object decides for one page or file request (K-1004). */
type ContentAnswer = { readonly stale: boolean } & (
  | { readonly decision: "allow"; readonly item: LibraryItem }
  | { readonly decision: "login" | "passkey" | "deny" | "missing" }
);

/** K-110: a redirect that also drops a login from before "Sign out everywhere". */
function redirect(location: string, stale: boolean) {
  const response = Response.redirect(location, 302);
  if (!stale) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", "CF_Authorization=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax");
  return new Response(null, { status: 302, headers });
}

/** The decoded path segment, or null for broken percent-encoding. */
const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/** K-1003, K-1004, K-1102: a page at `pages.<zone>/<id>` or a file at `files.<zone>/<id>/<name>`. */
/** The query mark of a return from a login step (K-1004). */
const RETURN_MARK = "kitshn-login";

async function content(request: Request, env: Env, kind: "page" | "file"): Promise<Response> {
  const url = new URL(request.url);
  const logins: ContentLogins =
    kind === "page"
      ? { login: env.PAGES_LOGIN_AUD, passkey: env.PAGES_PASSKEY_AUD }
      : { login: env.FILES_LOGIN_AUD, passkey: env.FILES_PASSKEY_AUD };
  if (url.pathname === "/login" || url.pathname === "/login/passkey") {
    // Access let the visitor through and set the cookie for the whole host; go back to the item, and say
    // which step this was, so the item never sends the visitor to the same step again (no redirect loop).
    const next = new URL(url.searchParams.get("next") ?? "/", url.origin);
    if (next.origin !== url.origin) return Response.redirect(url.origin, 302);
    // A short cookie on the item's path, not a URL mark, so a bookmark or a shared link never carries it.
    const step = url.pathname === "/login" ? "login" : "passkey";
    return new Response(null, {
      status: 302,
      headers: {
        location: `${next.origin}${next.pathname}`,
        "set-cookie": `${RETURN_MARK}=${step}; Max-Age=60; Path=${next.pathname}; Secure; HttpOnly; SameSite=Lax`,
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return text("Use GET.", 405);
  const [, id = "", ...rest] = url.pathname.split("/");
  if (!isLibraryId(id)) return text(`kitshn has no ${kind} here.`, 404);
  const { visitor, problem } = await contentVisitorOf(request, env, logins);
  const answer = (await (
    await env.KITSHN.getByName("kitshn").fetch("https://kitshn.internal/internal/content", {
      method: "POST",
      body: JSON.stringify({ id, visitor }),
    })
  ).json()) as ContentAnswer;
  const back = `?next=${encodeURIComponent(url.pathname)}`;
  const step = loginStep(
    answer.decision,
    cookieValues(request.headers.get("cookie"), RETURN_MARK)[0] ?? null,
  );
  if (step === "explain") {
    const reason = answer.stale
      ? `: this login is from before "Sign out everywhere" (K-110)`
      : problem
        ? `: ${problem}`
        : `${visitor.email ? ` as ${visitor.email}` : ""}${visitor.passkey ? " with a passkey" : ""}.`;
    const response = text(
      `Access let you in, but kitshn could not use the login on ${url.host}${reason}` +
        ` Log out at https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout, then open ${url.origin}${url.pathname} again.`,
      401,
    );
    // The next try starts clean: no old login, no return mark.
    response.headers.append(
      "set-cookie",
      "CF_Authorization=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
    );
    response.headers.append(
      "set-cookie",
      `${RETURN_MARK}=; Max-Age=0; Path=${url.pathname}; Secure; HttpOnly; SameSite=Lax`,
    );
    return response;
  }
  if (step === "login") return redirect(`${url.origin}/login${back}`, answer.stale);
  if (step === "passkey") return redirect(`${url.origin}/login/passkey${back}`, answer.stale);
  if (answer.decision === "deny")
    return text(
      `${visitor.email ?? visitor.clientId} has no access to this ${kind}. Ask its owner to share it.`,
      403,
    );
  if (answer.decision !== "allow" || answer.item.kind !== kind)
    return text(`kitshn has no ${kind} here.`, 404);
  const item = answer.item;
  if (kind === "file" && decoded(rest.join("/")) !== item.fileName) {
    return Response.redirect(`${url.origin}/${id}/${encodeURIComponent(item.fileName ?? "")}`, 302);
  }
  if (!env.BUCKET) return text("R2 is off for this kitshn. Run the bootstrap again after R2 is on.", 503);
  const object = request.method === "HEAD" ? null : await env.BUCKET.get(objectKey(item));
  if (request.method === "GET" && !object) return text(`The bytes of this ${kind} are missing in R2.`, 404);
  const headers = new Headers({
    "content-type": kind === "page" ? "text/html; charset=utf-8" : item.contentType,
    "content-length": String(item.size),
    "content-security-policy": contentSecurityPolicy(env.KITSHN_HOST),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
  });
  if (kind === "file")
    headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(item.fileName ?? "")}`);
  return new Response(object?.body ?? null, { headers });
}

interface OfflineInfo {
  readonly site: string;
  readonly reason: string;
  readonly seen: number | null;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === `pages.${env.KITSHN_ZONE}`) return content(request, env, "page");
    if (url.hostname === `files.${env.KITSHN_ZONE}`) return content(request, env, "file");
    if (url.hostname !== env.KITSHN_HOST && url.hostname.endsWith(`.${env.KITSHN_ZONE}`)) {
      return offline(request, env, ctx);
    }
    // K-718: agent keys. Access lets any service token in; the Durable Object decides what each may do.
    if (url.pathname.startsWith("/agent/")) {
      if (!env.ACCESS_AGENT_AUD)
        return Response.json({ error: "Run the bootstrap again to turn on agent keys." }, { status: 503 });
      const caller = await callerOf(request, env, env.ACCESS_AGENT_AUD);
      if (typeof caller === "string") return Response.json({ error: caller }, { status: 401 });
      if (caller.visitor.clientId === null)
        return Response.json({ error: "The agent path takes a service token only." }, { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("x-kitshn-caller", JSON.stringify(caller));
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    if (url.pathname.startsWith("/api/")) {
      // A browser sends Origin on a WebSocket and a cross-site POST. Only the map's own page may call.
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== url.origin) {
        return Response.json({ error: `kitshn refuses requests from ${origin}.` }, { status: 403 });
      }
      // K-1101: an upload sends its bytes; its metadata headers make a browser ask first (CORS preflight).
      const upload = url.pathname === "/api/pages" || url.pathname === "/api/files";
      if (upload && !request.headers.has("x-kitshn-name")) {
        return Response.json({ error: "Send the name in the X-Kitshn-Name header." }, { status: 400 });
      }
      if (
        !upload &&
        request.method === "POST" &&
        !request.headers.get("content-type")?.startsWith("application/json")
      ) {
        return Response.json({ error: "Send JSON with Content-Type: application/json." }, { status: 415 });
      }
      const caller = await callerOf(request, env, env.ACCESS_ADMIN_AUD);
      if (typeof caller === "string") return Response.json({ error: caller }, { status: 401 });
      const headers = new Headers(request.headers);
      headers.set("x-kitshn-caller", JSON.stringify(caller));
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    // K-604, K-812: the daemon connection, and the files of a deploy that the daemon runs.
    if (url.pathname === "/connect" || url.pathname.startsWith("/connect/deploys/")) {
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
