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
}

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
      /** The Compose file of the recipe; null lets Compose find `compose.yml` and its override file. */
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

/** K-818: checks an allow list from the map: at most 50 entries of a repo `owner/name` and a setting name. */
export function parseAllowances(value: unknown): Array<ComposeAllowance> | string {
  if (!Array.isArray(value) || value.length > 50) return "The allow list is a list of at most 50 entries.";
  const entries: Array<ComposeAllowance> = [];
  for (const item of value) {
    const entry = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const repo = typeof entry["repo"] === "string" ? entry["repo"].trim() : "";
    const setting = typeof entry["setting"] === "string" ? entry["setting"].trim() : "";
    const parts = repo.split("/");
    if (parts.length !== 2 || parts.some((part) => part === "" || part === "." || part === ".."))
      return `"${repo}" is not a repo; write owner/name.`;
    if (!setting || setting.length > 200 || setting.includes(" "))
      return `"${setting}" is not a setting name, for example bind:/var/run/docker.sock.`;
    entries.push({ repo, setting });
  }
  return entries;
}
