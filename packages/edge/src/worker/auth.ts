import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Actor } from "../core/changes.ts";
import type { ContentVisitor } from "../core/library.ts";
import type { Visitor } from "../core/visitor.ts";
import type { Env } from "./env.ts";

export interface Caller {
  readonly visitor: Visitor;
  readonly actor: Actor;
}

let jwks: { readonly team: string; readonly set: ReturnType<typeof createRemoteJWKSet> } | null = null;

const isLocal = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

/** K-404: the identity in an Access JWT that one of the audience tags signed, or a reason string. */
async function accessIdentity(
  token: string,
  env: Env,
  audiences: ReadonlyArray<string>,
): Promise<{ email: string | null; clientId: string | null; audience: string } | string> {
  const wanted = audiences.filter(Boolean);
  if (!env.ACCESS_TEAM_DOMAIN || wanted.length === 0) return "kitshn has no Access configuration.";
  if (jwks?.team !== env.ACCESS_TEAM_DOMAIN) {
    const certs = new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    jwks = { team: env.ACCESS_TEAM_DOMAIN, set: createRemoteJWKSet(certs) };
  }
  try {
    const { payload } = await jwtVerify(token, jwks.set, {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: wanted,
    });
    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    const clientId = typeof payload["common_name"] === "string" ? payload["common_name"] : null;
    const tokenAudiences = typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
    const audience = wanted.find((tag) => tokenAudiences.includes(tag));
    if (!audience) return "The Access token has none of the expected audience tags.";
    if (!email && !clientId) return "The Access token names no email and no service token.";
    return { email: email || null, clientId: email ? null : clientId, audience };
  } catch (error) {
    return `The Access token is not valid: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * K-404: the caller from the Access JWT, checked against the team keys and the audience tag of the
 * Access application of the path. Returns a reason string when the request has no valid identity.
 */
export async function callerOf(request: Request, env: Env, audience: string): Promise<Caller | string> {
  const url = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip");
  if (env.DEV_IDENTITY && isLocal(url)) {
    return {
      visitor: { email: env.DEV_IDENTITY, clientId: null, ip },
      actor: { _tag: "person", email: env.DEV_IDENTITY },
    };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return "The request has no Cloudflare Access token.";
  const identity = await accessIdentity(token, env, [audience]);
  if (typeof identity === "string") return identity;
  const { email, clientId } = identity;
  if (email) return { visitor: { email, clientId: null, ip }, actor: { _tag: "person", email } };
  return {
    visitor: { email: null, clientId, ip },
    actor: { _tag: "device", clientId: clientId ?? "", name: clientId ?? "" },
  };
}

/** The two login applications of a content host: `/login`, and `/login/passkey` with the passkey check. */
export interface ContentLogins {
  readonly login: string;
  readonly passkey: string;
}

const cookie = (request: Request, name: string) =>
  (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;

/**
 * K-1004: the visitor of a page or a file. Access sets the `CF_Authorization` cookie with `Path=/` at the
 * login path, so it comes with every request to the host. No valid cookie means an anonymous visitor.
 */
export async function contentVisitorOf(
  request: Request,
  env: Env,
  logins: ContentLogins,
): Promise<ContentVisitor> {
  const ip = request.headers.get("cf-connecting-ip");
  const anonymous: ContentVisitor = { email: null, clientId: null, ip, passkey: false };
  if (env.DEV_IDENTITY && isLocal(new URL(request.url)))
    return { email: env.DEV_IDENTITY, clientId: null, ip, passkey: true };
  const token = request.headers.get("cf-access-jwt-assertion") ?? cookie(request, "CF_Authorization");
  if (!token) return anonymous;
  const identity = await accessIdentity(token, env, [logins.login, logins.passkey]);
  if (typeof identity === "string") return anonymous;
  return {
    email: identity.email,
    clientId: identity.clientId,
    ip,
    passkey: identity.audience === logins.passkey,
  };
}

/** Who deploys: the repo of a GitHub Actions run, from its OIDC token (K-811). */
export interface Deployer {
  readonly repo: string;
  /** GitHub's id of the repo; unlike the name, it never changes or clashes. */
  readonly repoId: string;
  readonly ownerId: string;
  readonly sha: string;
  /** The event, the branch and the pull request come from the signed token, never from the request. */
  readonly eventName: string;
  readonly branch: string;
  readonly pr: number | null;
}

const github = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

/**
 * K-811: accepts a GitHub Actions OIDC token for this kitshn, from a repo of a listed owner account.
 * Returns a reason string for any other request.
 */
export async function deployerOf(request: Request, env: Env): Promise<Deployer | string> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer "))
    return "A deploy needs the GitHub Actions OIDC token (permissions: id-token: write).";
  const owners = env.DEPLOY_OWNER_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (owners.length === 0)
    return "This kitshn trusts no GitHub owner yet. Run the bootstrap with KITSHN_DEPLOY_OWNERS.";
  try {
    const { payload } = await jwtVerify(header.slice("Bearer ".length), github, {
      issuer: "https://token.actions.githubusercontent.com",
      audience: new URL(request.url).origin,
    });
    const text = (name: string) => (typeof payload[name] === "string" ? (payload[name] as string) : "");
    const [repo, repoId, ownerId, sha, eventName, ref] = [
      "repository",
      "repository_id",
      "repository_owner_id",
      "sha",
      "event_name",
      "ref",
    ].map(text) as [string, string, string, string, string, string];
    if (!repo || !repoId || !ownerId || !sha || !eventName) {
      return "The GitHub token has no repository, owner, commit or event.";
    }
    if (!owners.includes(ownerId)) return `kitshn does not trust the GitHub owner of ${repo} (K-811).`;
    const pull = /^refs\/pull\/(\d+)\//.exec(ref);
    const branch = eventName === "pull_request" ? text("head_ref") : ref.replace(/^refs\/heads\//, "");
    return { repo, repoId, ownerId, sha, eventName, branch, pr: pull ? Number(pull[1]) : null };
  } catch (error) {
    return `The GitHub token is not valid: ${error instanceof Error ? error.message : String(error)}`;
  }
}
