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
}

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
  | { readonly kind: "update"; readonly version: string };

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
  | { readonly type: "status"; readonly status: MachineStatus }
  | { readonly type: "sample"; readonly sample: Sample }
  | { readonly type: "jobResult"; readonly id: number; readonly result: JobResult }
  /** The whole list of live sites, sent on connect and on each change (K-1107). */
  | { readonly type: "sites"; readonly sites: ReadonlyArray<LiveSiteReport> };

/** Messages from kitshn to a daemon. */
export type ServerToDaemon = { readonly type: "job"; readonly id: number; readonly command: Command };

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
