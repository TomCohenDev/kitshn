import { describe, expect, it } from "vitest";
import {
  cloudflaredUrl,
  expectedHash,
  pathsFor,
  releaseAsset,
  serviceCommands,
  serviceFile,
  tunnelServiceFile,
  tunnelStateOf,
} from "./service.ts";

describe("daemon service (K-601)", () => {
  it("keeps the tokens in the user's config folder", () => {
    expect(pathsFor("linux", {}, "/home/u").config).toBe("/home/u/.config/kitshn/machine.json");
    expect(pathsFor("linux", { XDG_CONFIG_HOME: "/x" }, "/home/u").service).toBe(
      "/x/systemd/user/kitshn.service",
    );
    expect(pathsFor("darwin", {}, "/Users/u").service).toBe(
      "/Users/u/Library/LaunchAgents/com.kitshn.daemon.plist",
    );
  });

  it("restarts the daemon after every exit", () => {
    expect(serviceFile("linux", "/home/u/.local/bin/kitshn")).toContain(
      'ExecStart="/home/u/.local/bin/kitshn" run',
    );
    expect(serviceFile("linux", "/b")).toContain("Restart=always");
    expect(serviceFile("darwin", "/a&b")).toContain("<string>/a&amp;b</string>");
    expect(serviceCommands("linux", "/f", 1000).start.at(-1)).toEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "kitshn.service",
    ]);
  });

  it("runs the tunnel as its own service, with the token in a file (K-603)", () => {
    expect(pathsFor("linux", {}, "/home/u").tunnelService).toBe("/home/u/.config/systemd/user/kitshn-tunnel.service");
    const unit = tunnelServiceFile("linux", "/d/cloudflared", "/d/tunnel-token");
    expect(unit).toContain('--token-file "/d/tunnel-token"');
    expect(unit).toContain("Restart=always");
    expect(tunnelServiceFile("darwin", "/d/cloudflared", "/d/t")).toContain("<string>--token-file</string><string>/d/t</string>");
  });

  it("reads the tunnel state from its service manager (K-605)", () => {
    expect(tunnelStateOf("linux", "active\n")).toBe("running");
    expect(tunnelStateOf("linux", "activating\n")).toBe("starting");
    expect(tunnelStateOf("linux", "failed\n")).toBe("stopped");
    expect(tunnelStateOf("darwin", "com.kitshn.tunnel = {\n\tstate = running\n")).toBe("running");
    expect(tunnelStateOf("darwin", "")).toBe("stopped");
  });

  it("downloads the cloudflared of the platform", () => {
    expect(cloudflaredUrl("linux", "arm64").url).toMatch(/cloudflared-linux-arm64$/);
    expect(cloudflaredUrl("darwin", "x64")).toMatchObject({ archive: true });
    expect(() => cloudflaredUrl("linux", "ia32")).toThrow();
  });

  it("finds the daemon of a release and its hash in SHA256SUMS (K-617)", () => {
    expect(releaseAsset("linux", "arm64")).toBe("kitshn-linux-arm64");
    expect(() => releaseAsset("linux", "ia32")).toThrow();
    const sums = `${"a".repeat(64)}  kitshn-linux-arm64\n${"b".repeat(64)} *kitshn.mjs\n`;
    expect(expectedHash(sums, "kitshn-linux-arm64")).toBe("a".repeat(64));
    expect(expectedHash(sums, "kitshn.mjs")).toBe("b".repeat(64));
    expect(expectedHash(sums, "kitshn-linux-x64")).toBeNull();
  });
});
