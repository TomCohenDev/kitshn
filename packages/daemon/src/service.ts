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
}

export function pathsFor(
  platform: Platform,
  env: Record<string, string | undefined>,
  home = homedir(),
): Paths {
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support", "kitshn");
    return {
      config: join(support, "machine.json"),
      data: support,
      service: join(home, "Library", "LaunchAgents", "com.kitshn.daemon.plist"),
    };
  }
  const config = env["XDG_CONFIG_HOME"] || join(home, ".config");
  const data = env["XDG_DATA_HOME"] || join(home, ".local", "share");
  return {
    config: join(config, "kitshn", "machine.json"),
    data: join(data, "kitshn"),
    service: join(config, "systemd", "user", "kitshn.service"),
  };
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
