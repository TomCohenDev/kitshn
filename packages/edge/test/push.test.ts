import { afterEach, expect, it, vi } from "vitest";
import { generateVapidJwk, sendPush, vapidKey } from "../src/worker/push.ts";

afterEach(() => vi.restoreAllMocks());

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const concat = (...parts: Array<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const hkdf = async (salt: Uint8Array, secret: Uint8Array, info: Uint8Array, bytes: number) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]),
      bytes * 8,
    ),
  );

it("encrypts a push that only the browser of the subscription can read (RFC 8291, K-1907)", async () => {
  const browser = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const browserPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", browser.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  let sent: { headers: Headers; body: Uint8Array } | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    sent = { headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) };
    return new Response(null, { status: 201 });
  });
  const key = await vapidKey(await generateVapidJwk());
  if (!key) throw new Error("no key");
  const result = await sendPush(
    { endpoint: "https://push.example.com/send/abc", p256dh: b64url(browserPublic), auth: b64url(auth) },
    { title: "riffle is down" },
    key,
    "https://kit.example.com",
    { urgency: "high", topic: "topic" },
  );
  expect(result).toBe("delivered");
  if (!sent) throw new Error("nothing sent");
  const { headers, body } = sent as { headers: Headers; body: Uint8Array };
  expect(headers.get("urgency")).toBe("high");
  expect(headers.get("topic")).toBe("topic");
  expect(headers.get("authorization")).toMatch(/^vapid t=.+, k=/);
  // RFC 8188 header: salt (16), record size (4), key length (1), the sender key, then the cipher text.
  const salt = body.slice(0, 16);
  const senderKey = body.slice(21, 21 + (body[20] ?? 0));
  const cipher = body.slice(21 + senderKey.length);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          senderKey,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      browser.privateKey,
      256,
    ),
  );
  const encode = (text: string) => new TextEncoder().encode(text);
  const ikm = await hkdf(auth, shared, concat(encode("WebPush: info\0"), browserPublic, senderKey), 32);
  const cek = await hkdf(salt, ikm, encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
      cipher,
    ),
  );
  expect(plain.at(-1)).toBe(2);
  expect(JSON.parse(new TextDecoder().decode(plain.slice(0, -1)))).toEqual({ title: "riffle is down" });
});
