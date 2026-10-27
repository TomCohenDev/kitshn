import { describe, expect, it } from "vitest";
import {
  cloudflaredUrl,
  expectedHash,
  pathsFor,
  releaseAsset,
  serviceCommands,
  serviceFile,
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
