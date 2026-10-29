import { backupPassword, serveRestic } from "./restic.ts";
import {
  contentSecurityPolicy,
  type LibraryItem,
  addressNameError,
  addressSegment,
  isLibraryId,
  loginStep,
  objectKey,
} from "../core/library.ts";
import {
  type Caller,
  type ContentLogins,
  callerOf,
  contentVisitorOf,
  cookieValues,
  deployerOf,
  freshCallerOf,
  stepCookie,
  stepToken,
} from "./auth.ts";
import { type BadgeState, badgeSvg } from "../core/badge.ts";
import type { Usage } from "../core/usage.ts";
import { escapeHtml, originDown, seenText } from "./live.ts";
import type { Env } from "./env.ts";
import { readUsage } from "./usage.ts";
import { zoneFor, zonesOf, zonesOrMain } from "./zones.ts";

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
  | { readonly decision: "allow"; readonly item: LibraryItem; readonly address: string }
  | { readonly decision: "moved"; readonly address: string }
  | { readonly decision: "login" | "passkey" | "deny" | "missing" }
);

/** K-110: a redirect that also drops a login from before "Sign out everywhere". */
function redirect(location: string, stale: boolean) {
  const response = Response.redirect(location, 302);
  if (!stale) return response;
  const headers = new Headers(response.headers);
  for (const name of ["CF_Authorization", stepCookie("login"), stepCookie("passkey")])
    headers.append("set-cookie", `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
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
    // Access let the visitor through and sent the token of this step; go back to the item, and say which
    // step this was, so the item never sends the visitor to the same step again (no redirect loop).
    const next = new URL(url.searchParams.get("next") ?? "/", url.origin);
    // A `;` in the path would add attributes to the return mark cookie below.
    if (next.origin !== url.origin || next.pathname.includes(";")) return Response.redirect(url.origin, 302);
    const step = url.pathname === "/login" ? "login" : "passkey";
    const checked = await stepToken(
      request.headers.get("cf-access-jwt-assertion"),
      env,
      step === "login" ? logins.login : logins.passkey,
    );
    if (typeof checked === "string")
      return text(
        `Access let you through the ${step === "passkey" ? "passkey login" : "login"} on ${url.host}, but kitshn` +
          ` could not use it: ${checked} Log out at https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout,` +
          ` then open ${next.origin}${next.pathname} again.`,
        401,
      );
    const headers = new Headers({ location: `${next.origin}${next.pathname}` });
    // The Worker keeps the token of this step itself, because the other login application replaces
    // `CF_Authorization` (K-1004). It lives as long as the token.
    const maxAge = Math.max(0, checked.expiresAt - Math.floor(Date.now() / 1000));
    headers.append(
      "set-cookie",
      `${stepCookie(step)}=${checked.token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    // A short cookie on the item's path, not a URL mark, so a bookmark or a shared link never carries it.
    headers.append(
      "set-cookie",
      `${RETURN_MARK}=${step}; Max-Age=60; Path=${next.pathname}; Secure; HttpOnly; SameSite=Lax`,
    );
    return new Response(null, { status: 302, headers });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return text("Use GET.", 405);
  const [, segment = "", ...rest] = url.pathname.split("/");
  if (!isLibraryId(segment) && addressNameError(segment) !== null)
    return text(`kitshn has no ${kind} here.`, 404);
  const { visitor, problem, seen } = await contentVisitorOf(request, env, logins);
  const answer = (await (
    await env.KITSHN.getByName("kitshn").fetch("https://kitshn.internal/internal/content", {
      method: "POST",
      body: JSON.stringify({ segment, kind, visitor }),
    })
  ).json()) as ContentAnswer;
  // K-1127: a page that became a repo's site; the share check passed in the Durable Object.
  if (answer.decision === "moved") return Response.redirect(`https://${answer.address}/`, 302);
  const back = `?next=${encodeURIComponent(url.pathname)}`;
  const cameBack = cookieValues(request.headers.get("cookie"), RETURN_MARK)[0] ?? null;
  const step = loginStep(answer.decision, cameBack);
  if (step === "explain") {
    const reason = answer.stale
      ? `: this login is from before "Sign out everywhere" (K-110)`
      : problem
        ? `: ${problem}`
        : `${visitor.email ? ` as ${visitor.email}` : ""}${visitor.passkey ? " with a passkey" : ""}.`;
    const response = text(
      `Access let you in, but kitshn could not use the login on ${url.host}${reason}` +
        ` Log out at https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout, then open ${url.origin}${url.pathname} again.` +
        `\n\nWhat kitshn saw: kitshn wanted the ${answer.decision === "passkey" ? "passkey login" : "login"} after the ${cameBack} step;` +
        ` tokens: ${seen.length > 0 ? seen.join("; ") : "none"}.`,
      401,
    );
    // The next try starts clean: no old login, no return mark.
    for (const name of ["CF_Authorization", stepCookie("login"), stepCookie("passkey")])
      response.headers.append("set-cookie", `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
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
  // K-1120: an old name or the id sends the visitor to the current address, only after the share check, so a
  // stranger learns no new name. 302, because Undo can move the card back.
  const current = addressSegment(answer.address);
  if (segment !== current || (kind === "file" && decoded(rest.join("/")) !== item.fileName))
    return Response.redirect(`https://${answer.address}`, 302);
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

/** K-817: a host on a further zone of KITSHN_ZONES. A broken KITSHN_ZONES counts as none here. */
function onOtherZone(host: string, env: Env) {
  try {
    const zone = zoneFor(host, zonesOf(env));
    return zone !== null && zone.name !== env.KITSHN_ZONE;
  } catch {
    return false;
  }
}

/**
 * K-1118, K-1119: a public answer that the edge keeps for `seconds`, and a fault for 30 seconds, such as a 500 during a
 * version switch. Browsers get `no-store`: the zone's Browser Cache TTL raises any lower `max-age` to its own 4 hours,
 * and it leaves `no-store` alone.
 */
async function edgeCached(
  request: Request,
  ctx: ExecutionContext,
  key: string,
  seconds: number,
  /** `fault` keeps the answer 30 seconds, also when its status is 200. */
  load: () => Promise<{ readonly answer: Response; readonly fault: boolean }>,
) {
  const cache = caches.default;
  const cacheKey = new Request(key);
  const toBrowser = (answer: Response) => {
    const response = new Response(request.method === "HEAD" ? null : answer.body, answer);
    response.headers.set("cache-control", "no-store");
    response.headers.delete("age");
    return response;
  };
  const cached = await cache.match(cacheKey);
  if (cached) return toBrowser(cached);
  const { answer, fault } = await load();
  const stored = new Response(await answer.arrayBuffer(), answer);
  stored.headers.set("cache-control", `public, max-age=${fault ? 30 : seconds}`);
  ctx.waitUntil(cache.put(cacheKey, stored.clone()));
  return toBrowser(stored);
}

const publicHeaders = (contentType: string) => ({
  "content-type": contentType,
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
});

/** K-1118: public in Access. Any site may read it. The query string does not split the cache. */
function publicCards(request: Request, env: Env, ctx: ExecutionContext) {
  return edgeCached(request, ctx, `${new URL(request.url).origin}/public/cards.json`, 300, async () => {
    const answer = await env.KITSHN.getByName("kitshn")
      .fetch("https://kitshn.internal/internal/public-cards")
      .catch(() => Response.json({ error: "kitshn could not read its cards." }, { status: 503 }));
    return {
      answer: new Response(answer.body, {
        status: answer.status,
        headers: publicHeaders("application/json"),
      }),
      fault: !answer.ok,
    };
  });
}

const NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";

/** K-1119: a name that GitHub allows: letters, digits, `-` and the `extra` characters, at most `max` long. */
const githubName = (value: string, max: number, extra = "") =>
  value.length > 0 &&
  value.length <= max &&
  [...value].every((char) => NAME_CHARS.includes(char) || extra.includes(char));

/**
 * K-1119: `/public/badges/<owner>/<repo>.svg`, public in Access, with `app` and `env` as the only query keys that
 * count. A name that GitHub does not allow gets the `unknown` badge without a read, so random names cost nothing.
 * Every other path below `/public/badges/` is not found, so the Bypass application covers only badges.
 */
function badge(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const rest = url.pathname.slice("/public/badges/".length);
  const parts = rest.endsWith(".svg") ? rest.slice(0, -".svg".length).split("/") : [];
  if (parts.length !== 2)
    return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  const [owner = "", name = ""] = parts;
  const app = url.searchParams.get("app") ?? "app";
  const environment = url.searchParams.get("env") ?? "prod";
  const unknown = (fault: boolean) => ({
    answer: new Response(badgeSvg("unknown"), { headers: publicHeaders("image/svg+xml") }),
    fault,
  });
  if (!githubName(owner, 39) || !githubName(name, 100, "._") || app.length > 64 || environment.length > 64)
    return edgeCached(request, ctx, `${url.origin}/public/badges/unknown`, 60, async () => unknown(false));
  const query = new URLSearchParams({ repo: `${owner}/${name}`.toLowerCase(), app, env: environment });
  return edgeCached(request, ctx, `${url.origin}/public/badges?${query}`, 60, async () => {
    const answer = await env.KITSHN.getByName("kitshn")
      .fetch(`https://kitshn.internal/internal/badge?${query}`)
      .catch(() => null);
    // A fault draws `unknown` with status 200: GitHub's image proxy shows a broken image for any other status.
    if (!answer?.ok) return unknown(true);
    const { state } = (await answer.json()) as { state: BadgeState };
    return {
      answer: new Response(badgeSvg(state), { headers: publicHeaders("image/svg+xml") }),
      fault: false,
    };
  });
}

/**
 * K-1304: the Usage view while the Durable Object fails, for example after the daily rows read run out. The Worker
 * reads the values itself for an owner of OWNER_EMAILS and keeps them 5 minutes in the Cache API. Known limit: an
 * owner that the map added later, and not the bootstrap, gets no fallback.
 */
async function usageAnswer(
  request: Request,
  env: Env,
  caller: Caller,
  ctx: ExecutionContext,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("x-kitshn-caller", JSON.stringify(caller));
  const answer = await env.KITSHN.getByName("kitshn")
    .fetch(new Request(request, { headers }))
    .catch((error: unknown) => error);
  if (answer instanceof Response && answer.status < 500) return answer;
  const reason =
    answer instanceof Response ? `${answer.status}: ${(await answer.text()).slice(0, 300)}` : String(answer);
  const email = caller.visitor.email?.toLowerCase();
  const owner = env.OWNER_EMAILS.split(",").some((each) => each.trim().toLowerCase() === email);
  // The error text of the Durable Object is for owners only.
  if (!owner) return Response.json({ error: "kitshn did not answer." }, { status: 503 });
  if (!env.CLOUDFLARE_API_TOKEN)
    return Response.json({ error: `kitshn did not answer: ${reason}` }, { status: 503 });
  const key = new Request("https://kitshn.internal/usage");
  const cached = await caches.default.match(key);
  const usage = cached
    ? ((await cached.json()) as Usage)
    : await readUsage(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, zonesOrMain(env), Date.now());
  if (!cached)
    ctx.waitUntil(
      caches.default.put(key, Response.json(usage, { headers: { "cache-control": "max-age=300" } })),
    );
  return Response.json({ ...usage, kitshnDown: reason } satisfies Usage);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === `pages.${env.KITSHN_ZONE}`) return content(request, env, "page");
    if (url.hostname === `files.${env.KITSHN_ZONE}`) return content(request, env, "file");
    // K-1108, K-817: only an offline route brings a live site's request here, on any zone that kitshn publishes on.
    if (
      url.hostname !== env.KITSHN_HOST &&
      (url.hostname.endsWith(`.${env.KITSHN_ZONE}`) || onOtherZone(url.hostname, env))
    ) {
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
      // K-1504: "Resume" passes the passkey check of `/api/fresh` first; Access sends the owner back here.
      // K-1822: a restore to a time comes back to its own mark.
      if (url.pathname === "/api/fresh/start" && request.method === "GET")
        return Response.redirect(
          `${url.origin}/#${url.searchParams.get("then") === "restore" ? "restore-time" : "resume"}`,
          302,
        );
      if (url.pathname === "/api/fresh/resume" && request.method === "POST") {
        const fresh = await freshCallerOf(request, env, Date.now());
        if (typeof fresh === "string") return Response.json({ error: fresh }, { status: 401 });
        const headers = new Headers(request.headers);
        headers.set("x-kitshn-caller", JSON.stringify(fresh));
        return env.KITSHN.getByName("kitshn").fetch(
          new Request(`${url.origin}/fresh/resume`, { method: "POST", headers }),
        );
      }
      // K-1822: a restore to a time also needs a fresh passkey. The restart takes a moment, so the Worker asks
      // the restored Durable Object until it answers, and then it records the restore in History.
      if (url.pathname === "/api/fresh/restore-time" && request.method === "POST") {
        const fresh = await freshCallerOf(request, env, Date.now());
        if (typeof fresh === "string") return Response.json({ error: fresh }, { status: 401 });
        const body: unknown = await request.json().catch(() => null);
        const stub = () => env.KITSHN.getByName("kitshn");
        const call = (path: string, payload: unknown) =>
          stub().fetch(`${url.origin}${path}`, {
            method: "POST",
            headers: { "x-kitshn-caller": JSON.stringify(fresh), "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
        const started = await call("/fresh/restore-time", body);
        if (!started.ok) return started;
        // The finish comes from the object: its time label, the undo bookmark and the job ids.
        const finish = (await started.json()) as { undo: string };
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const recorded = await call("/fresh/restored", finish).catch(() => null);
          if (recorded?.ok) return Response.json({ undo: finish.undo });
        }
        return Response.json({
          undo: finish.undo,
          warning: "The restore ran. History records it at the next run of kitshn, within a few minutes.",
        });
      }
      if (url.pathname.startsWith("/api/fresh/"))
        return Response.json({ error: "Not found." }, { status: 404 });
      const caller = await callerOf(request, env, env.ACCESS_ADMIN_AUD);
      if (typeof caller === "string") return Response.json({ error: caller }, { status: 401 });
      if (url.pathname === "/api/usage" && request.method === "GET")
        return usageAnswer(request, env, caller, ctx);
      const headers = new Headers(request.headers);
      headers.set("x-kitshn-caller", JSON.stringify(caller));
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    // K-1813, K-1814: restic of a machine reaches the repository of a card only while it runs a job of that card.
    if (url.pathname.startsWith("/connect/backups/")) {
      const caller = await callerOf(request, env, env.ACCESS_CONNECT_AUD);
      if (typeof caller === "string") return Response.json({ error: caller }, { status: 401 });
      const clientId = caller.visitor.clientId;
      if (clientId === null)
        return Response.json({ error: "Only a machine's service token reaches backups." }, { status: 403 });
      const [first = "", ...rest] = url.pathname.slice("/connect/backups/".length).split("/");
      let card: string;
      try {
        card = decodeURIComponent(first);
      } catch {
        return Response.json({ error: "The card name is no valid path part." }, { status: 400 });
      }
      const allowed = await env.KITSHN.getByName("kitshn").fetch(
        "https://kitshn.internal/internal/backup-access",
        {
          method: "POST",
          body: JSON.stringify({ card, clientId }),
        },
      );
      if (!allowed.ok) return allowed;
      const path = `/${rest.join("/")}`;
      if (path === "/key") {
        if (!env.KITSHN_BACKUP_KEY)
          return Response.json(
            {
              error:
                "Backups are off: kitshn has no KITSHN_BACKUP_KEY. Run the bootstrap with KITSHN_BACKUP_KEY_NOW=1 (K-1815).",
            },
            { status: 503 },
          );
        return Response.json({ password: await backupPassword(env.KITSHN_BACKUP_KEY, card) });
      }
      if (!env.BUCKET) return Response.json({ error: "R2 is off on this account." }, { status: 503 });
      return serveRestic(env.BUCKET, card, path, request);
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
    if (url.pathname === "/public/cards.json" && (request.method === "GET" || request.method === "HEAD"))
      return publicCards(request, env, ctx);
    if (
      url.pathname.startsWith("/public/badges/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return badge(request, env, ctx);
    }
    // K-1118, K-1119: only these public paths exist; any other one is not found, never the app shell.
    if (url.pathname.startsWith("/public/"))
      return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
    // K-1706: "kitshn rekey" trades its one-time code in the same way.
    if ((url.pathname === "/join/exchange" || url.pathname === "/join/rekey") && request.method === "POST") {
      // A cheap shape check keeps junk away from the Durable Object; the code itself is the secret.
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { code?: unknown } | null;
      if (typeof body?.code !== "string" || !/^[23456789abcdefghjkmnpqrstuvwxyz]{20}$/.test(body.code)) {
        return Response.json({ error: "This is not a kitshn join code." }, { status: 400 });
      }
      // K-602: public; the one-time code is the secret. The Durable Object ignores any caller header.
      const headers = new Headers(request.headers);
      headers.delete("x-kitshn-caller");
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
