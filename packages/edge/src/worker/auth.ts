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
 * K-404: the caller from the Access JWT, checked against the team keys and the audience tags of the
 * applications in front of this Worker. Returns a reason string when the request has no valid identity.
 */
export async function callerOf(request: Request, env: Env): Promise<Caller | string> {
  const url = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip");
  if (env.DEV_IDENTITY && isLocal(url)) {
    return { visitor: { email: env.DEV_IDENTITY, clientId: null, ip }, actor: { _tag: "person", email: env.DEV_IDENTITY } };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return "The request has no Cloudflare Access token.";
  const audiences = env.ACCESS_AUDS.split(",").filter(Boolean);
  if (!env.ACCESS_TEAM_DOMAIN || audiences.length === 0) return "kitshn has no Access configuration.";
  if (jwks?.team !== env.ACCESS_TEAM_DOMAIN) {
    const certs = new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    jwks = { team: env.ACCESS_TEAM_DOMAIN, set: createRemoteJWKSet(certs) };
  }
  try {
    const { payload } = await jwtVerify(token, jwks.set, {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: audiences,
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
