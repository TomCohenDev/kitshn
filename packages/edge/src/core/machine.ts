/** A joined machine (K-602). Its resource card has the same id and the kind `machine`. */
export interface Machine {
  readonly id: string;
  readonly name: string;
  /** K-609 */
  readonly labels: ReadonlyArray<string>;
  /** K-609: one order of all machines; lower runs jobs first. */
  readonly order: number;
  /** The Access service token of the machine (K-107). */
  readonly serviceTokenId: string;
  readonly clientId: string;
  /** The remotely managed tunnel of the machine (K-603). */
  readonly tunnelId: string;
  /** K-818: risky Compose settings that the owner allows for one repo on this machine. */
  readonly allow?: ReadonlyArray<ComposeAllowance>;
  /** K-1702. Absent on a machine that joined before machine keys; it sends its first key (K-1708). */
  readonly key?: MachineKey;
}

export type MachineKey =
  /** K-1702: the public half of the machine key pair, and when it became valid. */
  | { readonly kind: "public"; readonly publicKey: string; readonly fingerprint: string; readonly since: number }
  /** K-1703, K-1706: the machine waits for its key from a join code or a rekey code, and cannot connect. */
  | { readonly kind: "waiting"; readonly since: number };

/** K-818: one allow list entry: a repo (`owner/name`) and one setting name of the daemon's check. */
export interface ComposeAllowance {
  readonly repo: string;
  readonly setting: string;
}

/** K-818: the settings that a machine allows for one repo. */
export const allowedFor = (machine: Machine, repo: string): Array<string> =>
  (machine.allow ?? []).filter((entry) => entry.repo.toLowerCase() === repo.toLowerCase()).map((entry) => entry.setting);

/** K-605: what a daemon reports about itself. */
export interface MachineStatus {
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly hostname: string;
  readonly tunnel: "starting" | "running" | "stopped";
  /** Job kinds that this daemon knows beyond shell, diagnostics and restart. Old daemons send none. */
  readonly capabilities?: ReadonlyArray<string>;
}

/** K-605, K-606: the latest resource sample. The Durable Object keeps it in memory only. */
export interface Sample {
  readonly at: number;
  readonly cpu: number;
  readonly memory: number;
  readonly disk: number;
}

/** K-612 built-in commands. */
export type Command =
  | { readonly kind: "shell"; readonly script: string }
  | { readonly kind: "diagnostics" }
  | { readonly kind: "restart" }
  /** K-612, K-617: replace the daemon with the release that the Worker names, then restart. */
  | { readonly kind: "update"; readonly version: string }
  /**
   * K-812: build and start a Compose app from the source of a deploy, then expose its socket as `name`
   * (K-607). Only kitshn makes this job, never the jobs API.
   */
  | {
      readonly kind: "compose";
      readonly deployId: string;
      /** K-818: the risky Compose settings that the owner allows for this repo on this machine. */
      readonly allowed: ReadonlyArray<string>;
      readonly project: string;
      readonly name: string;
      readonly environment: string;
      readonly repo: string;
      /** The Compose file of the recipe; with null, the daemon takes the files that Compose finds on its own. */
      readonly file: string | null;
    }
  /**
   * K-718: start the last build of a Compose app that came up, from the copy on the machine. It never takes
   * new code. Only kitshn makes this job, never the jobs API.
   */
  | {
      readonly kind: "compose-redeploy";
      readonly allowed: ReadonlyArray<string>;
      readonly project: string;
      readonly name: string;
      readonly environment: string;
      readonly repo: string;
      readonly file: string | null;
    }
  /** K-904: stop a Compose app and stop exposing it; a preview also loses its data. */
  | {
      readonly kind: "compose-down";
      readonly project: string;
      readonly name: string;
      readonly removeData: boolean;
    };

export interface JobResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly output: string;
}

/** K-1104, K-1107: a live site that a machine exposes, and whether its local server answers. */
export interface LiveSiteReport {
  readonly name: string;
  readonly target: string;
  readonly dev: boolean;
  readonly up: boolean;
}

/** Messages from a daemon to kitshn over `/connect`. The text "ping" is answered by the auto response. */
export type DaemonMessage =
  /** K-1704: the signature of `connectText`. kitshn uses `publicKey` only for a machine without a key (K-1708). */
  | { readonly type: "answer"; readonly signature: string; readonly publicKey: string }
  /** K-1705: a new public half, with the signature of `rotateText` by the old private half. */
  | { readonly type: "rotate"; readonly publicKey: string; readonly signature: string }
  | { readonly type: "status"; readonly status: MachineStatus }
  | { readonly type: "sample"; readonly sample: Sample }
  | { readonly type: "jobResult"; readonly id: number; readonly result: JobResult }
  /** The whole list of live sites, sent on connect and on each change (K-1107). */
  | { readonly type: "sites"; readonly sites: ReadonlyArray<LiveSiteReport> };

/** Messages from kitshn to a daemon. */
export type ServerToDaemon =
  /**
   * K-1704: the first message of each connection. `fingerprint` names the key that kitshn expects, so a daemon
   * in the middle of a rotation signs with the right file; null when the machine has no key yet (K-1708).
   */
  | { readonly type: "challenge"; readonly challenge: string; readonly fingerprint: string | null }
  /** K-1704: the answer passed; from now on kitshn reads the messages of this connection. */
  | { readonly type: "accepted"; readonly fingerprint: string }
  /** K-1705: "Rotate key" in the machine panel. */
  | { readonly type: "rotateKey" }
  | { readonly type: "job"; readonly id: number; readonly command: Command };

const ED25519 = { name: "Ed25519" } as const;

const base64url = (data: Uint8Array) =>
  base64(data).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unbase64url = (text: string) => unbase64(text.replaceAll("-", "+").replaceAll("_", "/"));

/** K-1702: the private half of a machine key, as the daemon keeps it in `machine.key`. */
export interface MachinePrivateKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  /** The public half, base64url of the 32 raw bytes; this is the public key on the wire. */
  readonly x: string;
  readonly d: string;
}

/** K-1701: a new Ed25519 key pair. */
export async function newMachineKey(): Promise<MachinePrivateKey> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const { x, d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { x?: string; d?: string };
  if (!x || !d) throw new Error("Web Crypto exported an Ed25519 key without its x or d.");
  return { kty: "OKP", crv: "Ed25519", x, d };
}

/** A machine key from `machine.key`, or null when the value is not one. */
export function parsePrivateKey(value: unknown): MachinePrivateKey | null {
  if (typeof value !== "object" || value === null) return null;
  const { kty, crv, x, d } = value as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519" || parsePublicKey(x) === null || typeof d !== "string") return null;
  return { kty, crv, x: x as string, d };
}

/** A public key from the wire: base64url of 32 bytes. Null for anything else. */
export function parsePublicKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 43) return null;
  try {
    return unbase64url(value).length === 32 ? value : null;
  } catch {
    return null;
  }
}

/** K-1702: the fingerprint of a public key: `SHA256:` and the base64url of the hash of its raw bytes. */
export const fingerprintOf = async (publicKey: string) =>
  `SHA256:${base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", unbase64url(publicKey))))}`;

/** K-1704: 32 random bytes for one connection. */
export const newChallenge = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** K-1704: what the daemon signs to answer the challenge of one connection to one kitshn host. */
export const connectText = (host: string, machineId: string, challenge: string) =>
  ["kitshn-connect-v1", host, machineId, challenge].join("\n");

/** K-1705: what the old key signs to hand over to the new one, bound to the connection like `connectText`. */
export const rotateText = (host: string, machineId: string, challenge: string, publicKey: string) =>
  ["kitshn-rotate-v1", host, machineId, challenge, publicKey].join("\n");

export async function signText(key: MachinePrivateKey, text: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey("jwk", key, ED25519, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign(ED25519, privateKey, bytes(text))));
}

/** False for a wrong signature and for a key or a signature that is not one. */
export async function verifyText(publicKey: string, text: string, signature: unknown): Promise<boolean> {
  if (parsePublicKey(publicKey) === null || typeof signature !== "string") return false;
  try {
    const key = await crypto.subtle.importKey("raw", unbase64url(publicKey), ED25519, false, ["verify"]);
    return await crypto.subtle.verify(ED25519, key, unbase64url(signature), bytes(text));
  } catch {
    return false;
  }
}

/** What a join code unlocks (K-602). The Worker stores it only encrypted with a key from the code. */
export interface JoinSecrets {
  readonly server: string;
  readonly machineId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tunnelToken: string;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const unbase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** The lookup id of a code. It reveals nothing about the key. */
export const joinLookup = async (code: string) =>
  hex(await crypto.subtle.digest("SHA-256", bytes(`lookup:${code}`)));

const joinKey = async (code: string) =>
  crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", bytes(`key:${code}`)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

export async function sealJoin(code: string, secrets: JoinSecrets): Promise<{ iv: string; sealed: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await joinKey(code),
    bytes(JSON.stringify(secrets)),
  );
  return { iv: base64(iv), sealed: base64(new Uint8Array(sealed)) };
}

export async function openJoin(code: string, box: { iv: string; sealed: string }): Promise<JoinSecrets> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unbase64(box.iv) },
    await joinKey(code),
    unbase64(box.sealed),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as JoinSecrets;
}

/** A join code: 20 random characters from an alphabet without look-alikes, about 100 bits. */
export function newJoinCode(): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const random = crypto.getRandomValues(new Uint8Array(20));
  return [...random].map((value) => alphabet[value % alphabet.length]).join("");
}

/** K-818: checks an allow list from the map: at most 50 entries of a repo `owner/name` and a setting name. */
export function parseAllowances(value: unknown): Array<ComposeAllowance> | string {
  if (!Array.isArray(value) || value.length > 50) return "The allow list is a list of at most 50 entries.";
  const entries: Array<ComposeAllowance> = [];
  for (const item of value) {
    const entry = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const repo = typeof entry["repo"] === "string" ? entry["repo"].trim() : "";
    const setting = typeof entry["setting"] === "string" ? entry["setting"].trim() : "";
    const parts = repo.split("/");
    const blank = (text: string) => [...text].some((char) => char.trim() === "");
    if (parts.length !== 2 || blank(repo) || parts.some((part) => part === "" || part === "." || part === ".."))
      return `"${repo}" is not a repo; write owner/name.`;
    if (!setting || setting.length > 200 || blank(setting))
      return `"${setting}" is not a setting name, for example bind:/var/run/docker.sock.`;
    entries.push({ repo, setting });
  }
  return entries;
}
