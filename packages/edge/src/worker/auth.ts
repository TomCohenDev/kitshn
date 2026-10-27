import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Actor } from "../core/changes.ts";
import type { Visitor } from "../core/visitor.ts";
import type { Env } from "./env.ts";

export interface Caller {
  readonly visitor: Visitor;
  readonly actor: Actor;
}

let jwks: { readonly team: string; readonly set: ReturnType<typeof createRemoteJWKSet> } | null = null;

const isLocal = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

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
  if (!env.ACCESS_TEAM_DOMAIN || !audience) return "kitshn has no Access configuration.";
  if (jwks?.team !== env.ACCESS_TEAM_DOMAIN) {
    const certs = new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    jwks = { team: env.ACCESS_TEAM_DOMAIN, set: createRemoteJWKSet(certs) };
  }
  try {
    const { payload } = await jwtVerify(token, jwks.set, {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience,
    });
    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    const clientId = typeof payload["common_name"] === "string" ? payload["common_name"] : null;
    if (email) return { visitor: { email, clientId: null, ip }, actor: { _tag: "person", email } };
    if (clientId) {
      return { visitor: { email: null, clientId, ip }, actor: { _tag: "device", clientId, name: clientId } };
    }
    return "The Access token names no email and no service token.";
  } catch (error) {
    return `The Access token is not valid: ${error instanceof Error ? error.message : String(error)}`;
  }
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
