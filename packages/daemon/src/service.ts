import { homedir } from "node:os";
import { join } from "node:path";

export type Platform = "linux" | "darwin";

export interface Paths {
  /** Holds the machine token and the tunnel token, mode 0600 (K-602). */
  readonly config: string;
  /** cloudflared and the 30-day sample history (K-606). */
  readonly data: string;
  /** The service file of the platform. */
  readonly service: string;
  /** K-603: the service file of the tunnel, a second user service next to the daemon. */
  readonly tunnelService: string;
  /** K-701: the local socket of the daemon. */
  readonly socket: string;
  /** K-701: the socket for the users in `localUsers`, in a folder of the daemon user that others can pass. */
  readonly sharedSocket: string;
}

export function pathsFor(
  platform: Platform,
  env: Record<string, string | undefined>,
  home = homedir(),
  uid = process.getuid!(),
): Paths {
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support", "kitshn");
    return {
      socket: join(support, "kitshn.sock"),
      sharedSocket: sharedSocketOf(uid),
      config: join(support, "machine.json"),
      data: support,
      service: join(home, "Library", "LaunchAgents", "com.kitshn.daemon.plist"),
      tunnelService: join(home, "Library", "LaunchAgents", "com.kitshn.tunnel.plist"),
    };
  }
  const config = env["XDG_CONFIG_HOME"] || join(home, ".config");
  const data = env["XDG_DATA_HOME"] || join(home, ".local", "share");
  // systemd sets XDG_RUNTIME_DIR for a user service; a shell without a login session may not.
  const runtime = env["XDG_RUNTIME_DIR"] || `/run/user/${uid}`;
  return {
    socket: join(runtime, "kitshn", "kitshn.sock"),
    sharedSocket: sharedSocketOf(uid),
    config: join(config, "kitshn", "machine.json"),
    data: join(data, "kitshn"),
    service: join(config, "systemd", "user", "kitshn.service"),
    tunnelService: join(config, "systemd", "user", "kitshn-tunnel.service"),
  };
}

/** K-701: the private socket folder sits in a folder that only its user can pass, so the shared one is in /tmp. */
const sharedSocketOf = (uid: number) => `/tmp/kitshn-${uid}/kitshn.sock`;

/**
 * K-701: the user id of the daemon that a client expects at the socket: `KITSHN_DAEMON_UID`, else the id in the
 * name of a shared socket folder, else its own. A string is the reason when `KITSHN_DAEMON_UID` is not a user id.
 */
export function expectedDaemonUid(env: Record<string, string | undefined>, socket: string, own: number): number | string {
  const given = env["KITSHN_DAEMON_UID"];
  if (given !== undefined && given !== "") {
    const uid = Number(given);
    return Number.isInteger(uid) && uid >= 0 ? uid : `KITSHN_DAEMON_UID=${given} is not a user id.`;
  }
  const folder = socket.endsWith("/kitshn.sock") ? socket.slice(0, -"/kitshn.sock".length) : "";
  const id = folder.startsWith("/tmp/kitshn-") ? folder.slice("/tmp/kitshn-".length) : "";
  return id !== "" && [...id].every((char) => char >= "0" && char <= "9") ? Number(id) : own;
}

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * K-601: a user service. systemd restarts the daemon after a crash and after `restart` (exit 0); launchd
 * does the same with KeepAlive. A user service needs no root; on Linux it runs without a login only with
 * `loginctl enable-linger`.
 */
export function serviceFile(platform: Platform, binary: string): string {
  if (platform === "darwin") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kitshn.daemon</string>
  <key>ProgramArguments</key><array><string>${xml(binary)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
  }
  return `[Unit]
Description=kitshn daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${binary}" run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * K-603: the tunnel is its own user service, so a restart or an update of the daemon never stops it. The token
 * stays in a file of the user (`--token-file`), not on the command line.
 */
export function tunnelServiceFile(platform: Platform, cloudflared: string, tokenFile: string): string {
  if (platform === "darwin") {
    const args = [cloudflared, "--no-autoupdate", "tunnel", "run", "--token-file", tokenFile];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kitshn.tunnel</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
  }
  return `[Unit]
Description=kitshn tunnel (cloudflared)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${cloudflared}" --no-autoupdate tunnel run --token-file "${tokenFile}"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** One step of a service command; `mayFail` for a step whose failure means "already so". */
export interface Step {
  readonly argv: ReadonlyArray<string>;
  readonly mayFail: boolean;
}

/**
 * K-603: start (idempotent), restart with a changed service file, stop and read the tunnel service. On macOS a
 * changed plist needs `bootout` and `bootstrap`; `kickstart` would run the old definition.
 */
export function tunnelCommands(platform: Platform, file: string, uid: number) {
  if (platform === "darwin") {
    const bootstrap = { argv: ["launchctl", "bootstrap", `gui/${uid}`, file], mayFail: false };
    const bootout = { argv: ["launchctl", "bootout", `gui/${uid}`, file], mayFail: true };
    return {
      // `bootstrap` fails when the agent is loaded already.
      start: [{ ...bootstrap, mayFail: true }],
      restart: [bootout, bootstrap],
      stop: [bootout],
      state: ["launchctl", "print", `gui/${uid}/com.kitshn.tunnel`],
    } satisfies Record<string, ReadonlyArray<Step> | ReadonlyArray<string>>;
  }
  const reload = { argv: ["systemctl", "--user", "daemon-reload"], mayFail: false };
  return {
    start: [reload, { argv: ["systemctl", "--user", "enable", "--now", "kitshn-tunnel.service"], mayFail: false }],
    restart: [
      reload,
      { argv: ["systemctl", "--user", "enable", "kitshn-tunnel.service"], mayFail: false },
      { argv: ["systemctl", "--user", "restart", "kitshn-tunnel.service"], mayFail: false },
    ],
    stop: [{ argv: ["systemctl", "--user", "disable", "--now", "kitshn-tunnel.service"], mayFail: true }],
    state: ["systemctl", "--user", "is-active", "kitshn-tunnel.service"],
  } satisfies Record<string, ReadonlyArray<Step> | ReadonlyArray<string>>;
}

/** K-605: the tunnel state for the status report, from the output of the state command. */
export function tunnelStateOf(platform: Platform, output: string): "starting" | "running" | "stopped" {
  if (platform === "darwin") return output.includes("state = running") ? "running" : "stopped";
  const state = output.trim();
  if (state === "active") return "running";
  return state === "activating" || state === "reloading" ? "starting" : "stopped";
}

/** The commands that start and stop the service of the platform. */
export function serviceCommands(platform: Platform, file: string, uid: number) {
  if (platform === "darwin") {
    return {
      start: [["launchctl", "bootstrap", `gui/${uid}`, file]],
      stop: [["launchctl", "bootout", `gui/${uid}`, file]],
    };
  }
  return {
    start: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "kitshn.service"],
    ],
    stop: [
      ["systemctl", "--user", "disable", "--now", "kitshn.service"],
      ["systemctl", "--user", "daemon-reload"],
    ],
  };
}

/** The cloudflared download for this platform (K-603). The daemon never uses another program's copy. */
export function cloudflaredUrl(platform: Platform, arch: string): { url: string; archive: boolean } {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!cpu) throw new Error(`kitshn has no cloudflared for the CPU ${arch}.`);
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  return platform === "darwin"
    ? { url: `${base}/cloudflared-darwin-${cpu}.tgz`, archive: true }
    : { url: `${base}/cloudflared-linux-${cpu}`, archive: false };
}

/** K-617: where kitshn releases live. Each release edge-<version> holds the daemons and SHA256SUMS. */
export const RELEASES = "https://github.com/Yarden-zamir/kitshn/releases/download";

/** The daemon file of a platform in a release. */
export function releaseAsset(platform: Platform, arch: string): string {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) throw new Error(`kitshn has no daemon for the CPU ${arch}.`);
  return `kitshn-${platform}-${cpu}`;
}

/** The hash that SHA256SUMS (the output of sha256sum) lists for one file, or null. */
export function expectedHash(sums: string, file: string): string | null {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    if (name === file && hash && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  return null;
}
