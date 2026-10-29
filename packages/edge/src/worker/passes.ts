// K-1770 to K-1775: kitshn as an OpenID issuer of short passes for outside services. kitshn's own actions never use
// passes (K-1710).
import { SignJWT, importJWK, type JWK } from "jose";

/** K-1772: a pass lives 5 minutes. */
export const PASS_SECONDS = 300;
/** K-1771: the JWKS lists a retired key 5 minutes of pass life plus 1 minute of leeway, and at most 5 keys. */
export const RETIRED_MS = 6 * 60_000;
export const MAX_KEYS = 5;

/** K-1771: one row of `pass_keys`; the private half never leaves this table (backups.ts leaves the table out). */
export interface PassKey {
  readonly kid: string;
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
  readonly createdAt: number;
  readonly retiredAt: number | null;
}

/** K-1771: a new ES256 (P-256) key pair. */
export async function newPassKey(now: number): Promise<PassKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const kid = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JWK;
  // A verifier takes only the public fields; `key_ops` of the private half would say "sign".
  const { d: _, key_ops: _ops, ext: _ext, ...publicJwk } = privateJwk;
  return {
    kid,
    privateJwk: { ...privateJwk, kid, alg: "ES256", use: "sig" },
    publicJwk: { ...publicJwk, kid, alg: "ES256", use: "sig" },
    createdAt: now,
    retiredAt: null,
  };
}

/** K-1770: the discovery document; it names no authorization endpoint, because only machines get passes. */
export const discovery = (issuer: string) => ({
  issuer,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  id_token_signing_alg_values_supported: ["ES256"],
  response_types_supported: ["id_token"],
  subject_types_supported: ["public"],
  claims_supported: ["iss", "aud", "sub", "iat", "exp", "jti", "act", "kitshn_labels"],
});

/** K-1771: the public halves that verifiers may use now: the current key and keys retired in the last 6 minutes. */
export const jwks = (keys: ReadonlyArray<PassKey>, now: number) => ({
  keys: keys
    .filter((key) => key.retiredAt === null || now - key.retiredAt < RETIRED_MS)
    .slice(0, MAX_KEYS)
    .map((key) => key.publicJwk),
});

/**
 * K-1772: one pass for one audience. `labels` are the attested labels, given only when the audience allows them;
 * `act` names the attested thread then.
 */
export async function signPass(
  key: PassKey,
  claims: {
    readonly issuer: string;
    readonly audience: string;
    readonly machineId: string;
    readonly labels: Readonly<Record<string, string>> | null;
  },
  now: number,
): Promise<{ readonly pass: string; readonly expiresAt: number }> {
  const iat = Math.floor(now / 1000);
  const jti = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const thread = claims.labels?.["t3.thread.id"];
  const payload = {
    ...(claims.labels ? { kitshn_labels: claims.labels } : {}),
    ...(claims.labels && thread ? { act: { sub: `t3:${thread}` } } : {}),
  };
  const pass = await new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
    .setIssuer(claims.issuer)
    .setAudience(claims.audience)
    .setSubject(`machine:${claims.machineId}`)
    .setIssuedAt(iat)
    .setExpirationTime(iat + PASS_SECONDS)
    .setJti(jti)
    .sign(await importJWK(key.privateJwk, "ES256"));
  return { pass, expiresAt: (iat + PASS_SECONDS) * 1000 };
}
