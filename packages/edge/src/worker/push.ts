/**
 * K-1907: Web Push with the Web Crypto API, from `packages/shared/src/webPush.ts` of the T3 Code fork (MM-1807). It
 * signs the VAPID JWT (RFC 8292) and encrypts the message with `aes128gcm` (RFC 8291, RFC 8188). The key is a P-256
 * private key as JSON Web Key.
 */

export interface PushTarget {
  readonly endpoint: string;
  /** The public key of the browser, base64url. */
  readonly p256dh: string;
  /** The auth secret of the browser, base64url. */
  readonly auth: string;
}

export interface VapidKey {
  readonly privateKey: CryptoKey;
  /** The public key as an uncompressed point, base64url. Browsers subscribe with it. */
  readonly publicKey: string;
}

/** `delivered`, or `gone` when the push service no longer knows the subscription. */
export type PushResult = "delivered" | "gone";

/** A push service keeps a message this long for a device that is offline. */
const TTL_SECONDS = 24 * 60 * 60;
/** One record holds the whole message (RFC 8188). */
const RECORD_SIZE = 4096;
/** The JWT of a push service lasts at most 24 hours (RFC 8292). */
const JWT_SECONDS = 12 * 60 * 60;

const textEncoder = new TextEncoder();
/** `TextEncoder.encode` with the buffer type that Web Crypto takes. */
const encoder = { encode: (text: string) => new Uint8Array(textEncoder.encode(text)) };

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  secret: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
};

/** A new P-256 private key as JSON Web Key text, for `vapidKey`. */
export async function generateVapidJwk(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  // The Workers types also allow a single key here. ECDSA always gives a pair.
  if (!("privateKey" in pair)) throw new Error("ECDSA did not give a key pair.");
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/** Reads a JSON Web Key. Returns null without a key, and fails on a key that is not P-256. */
export async function vapidKey(jwkText: string | undefined): Promise<VapidKey | null> {
  if (!jwkText) return null;
  const jwk: unknown = JSON.parse(jwkText);
  if (
    typeof jwk !== "object" ||
    jwk === null ||
    !("kty" in jwk && jwk.kty === "EC") ||
    !("crv" in jwk && jwk.crv === "P-256") ||
    !("x" in jwk && typeof jwk.x === "string") ||
    !("y" in jwk && typeof jwk.y === "string") ||
    !("d" in jwk && typeof jwk.d === "string")
  ) {
    throw new Error("The VAPID key must be a P-256 private key as JSON Web Key.");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const point = concat(new Uint8Array([4]), fromBase64Url(jwk.x), fromBase64Url(jwk.y));
  return { privateKey, publicKey: toBase64Url(point) };
}

/** RFC 8292: the push service checks that the owner of the key sent the message. */
async function vapidHeader(endpoint: string, key: VapidKey, subject: string): Promise<string> {
  const part = (value: object) => toBase64Url(encoder.encode(JSON.stringify(value)));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + JWT_SECONDS,
    sub: subject,
  };
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  // Web Crypto gives the raw r and s of the signature, which is the JWS format.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    encoder.encode(unsigned),
  );
  return `vapid t=${unsigned}.${toBase64Url(new Uint8Array(signature))}, k=${key.publicKey}`;
}

/** RFC 8291: only the browser of the subscription can read the message. */
async function encrypt(target: PushTarget, plain: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const browserKey = fromBase64Url(target.p256dh);
  const authSecret = fromBase64Url(target.auth);
  const browserPublic = await crypto.subtle.importKey(
    "raw",
    browserKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const own = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  // The Workers types also allow a single key here. ECDH always gives a pair.
  if (!("privateKey" in own)) throw new Error("ECDH did not give a key pair.");
  const ownPublic = new Uint8Array((await crypto.subtle.exportKey("raw", own.publicKey)) as ArrayBuffer);
  const shared = new Uint8Array(
    // workerd reads the ECDH member as `public` (test/push.test.ts), but the Workers types call it `$public`.
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: browserPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      own.privateKey,
      256,
    ),
  );
  const keyInfo = concat(encoder.encode("WebPush: info\0"), browserKey, ownPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // The delimiter 2 marks the last record. The message has no padding.
  const record = concat(plain, new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  const header = new Uint8Array(21);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header.set(salt);
  header[20] = ownPublic.length;
  return concat(header, ownPublic, cipher);
}

/** How a push service treats a message: `urgency` (RFC 8030) and a `topic` that replaces an older waiting one. */
export interface PushOptions {
  readonly urgency: "normal" | "high";
  /** At most 32 base64url characters (RFC 8030). */
  readonly topic: string;
}

/** Sends one message to one subscription. Fails on every answer except success and `gone`. */
export async function sendPush(
  target: PushTarget,
  message: object,
  key: VapidKey,
  subject: string,
  options: PushOptions,
): Promise<PushResult> {
  const plain = encoder.encode(JSON.stringify(message));
  // The record holds the message, its delimiter and the 16-byte tag.
  if (plain.length > RECORD_SIZE - 17) throw new Error("The push message is too long.");
  const response = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(target.endpoint, key, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(TTL_SECONDS),
      Urgency: options.urgency,
      Topic: options.topic,
    },
    body: await encrypt(target, plain),
  });
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return "gone";
  }
  if (!response.ok) {
    throw new Error(`The push service answered ${response.status}: ${await response.text()}`);
  }
  return "delivered";
}

/** A `Topic` header from any text: the first 24 bytes of its SHA-256, which are 32 base64url characters. */
export async function pushTopic(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return toBase64Url(digest.slice(0, 24));
}
