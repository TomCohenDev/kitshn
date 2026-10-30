import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SiteEntry } from "./sites.ts";
import { describe, expect, it } from "vitest";
import { pathsFor } from "./service.ts";
import {
  SOCKET_PATH_LIMIT,
  appSocketFolder,
  jobSocketFolder,
  removeOldSockets,
  socketPathProblem,
  upOnSocket,
} from "./sockets.ts";

/** K-804: the longest card id; a longer one ends in a hash. */
const LONGEST_CARD = `app-${"r".repeat(39)}-1234567-prod`;

describe("socket paths (K-607)", () => {
  it("fit the limit of each system with the longest card id", () => {
    expect(LONGEST_CARD).toHaveLength(56);
    const systems = [
      // The daemon user of the join script.
      { platform: "linux", data: pathsFor("linux", {}, "/home/kitshn", 1000).data },
      // A long macOS user name.
      { platform: "darwin", data: pathsFor("darwin", {}, "/Users/a-long-user-name-of-24", 501).data },
    ] as const;
    for (const { platform, data } of systems) {
      for (const path of [
        join(appSocketFolder(data, LONGEST_CARD), "default.sock"),
        join(jobSocketFolder(data, crypto.randomUUID()), "proxy.sock"),
      ]) {
        expect(Buffer.byteLength(path)).toBeLessThanOrEqual(SOCKET_PATH_LIMIT[platform]);
        expect(socketPathProblem(path, platform)).toBeNull();
      }
    }
  });

  it("keeps one folder per card, and refuses a path over the limit with its reason", () => {
    expect(appSocketFolder("/d", LONGEST_CARD)).toBe(appSocketFolder("/d", LONGEST_CARD));
    expect(appSocketFolder("/d", "a")).not.toBe(appSocketFolder("/d", "b"));
    const long = `/${"x".repeat(SOCKET_PATH_LIMIT.darwin)}`;
    expect(socketPathProblem(long, "darwin")).toMatch(/104 bytes, more than the 103/);
    expect(socketPathProblem(long, "linux")).toBeNull();
  });

  it("points the site at the new socket when up starts, also when up fails, and keeps it when nothing started", async () => {
    const old: SiteEntry = { name: "app", target: "unix:/d/apps/app/sockets/default.sock", dev: false };
    let sites: ReadonlyArray<SiteEntry> = [old];
    const store = { read: () => sites, write: (next: ReadonlyArray<SiteEntry>) => (sites = next) };
    const socketPath = join(appSocketFolder("/d", "app"), "default.sock");
    await expect(
      upOnSocket(store, { name: "app", socketPath }, () => Promise.reject(new Error("up failed"))),
    ).rejects.toThrow("up failed");
    expect(sites).toEqual([{ name: "app", target: `unix:${socketPath}`, dev: false }]);
    // A broken sites.json fails before `up` runs, so the old app starts again on its old route.
    let ran = false;
    const broken = { read: () => null, write: () => undefined };
    await expect(
      upOnSocket(broken, { name: "app", socketPath }, () => Promise.resolve(void (ran = true))),
    ).rejects.toThrow(/broken/);
    expect(ran).toBe(false);
  });

  it("removes an old sockets folder that holds only sockets, and keeps one with any other entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "kitshn-sockets-"));
    const listen = (path: string) =>
      new Promise<ReturnType<typeof createServer>>((done) => {
        const server = createServer();
        server.listen(path, () => done(server));
      });
    const servers = [];
    try {
      const only = join(root, "only");
      const mixed = join(root, "mixed");
      mkdirSync(only);
      mkdirSync(mixed);
      servers.push(await listen(join(only, "default.sock")), await listen(join(mixed, "default.sock")));
      writeFileSync(join(mixed, "notes.txt"), "keep me");
      expect(removeOldSockets(only)).toMatch(/remove the old sockets folder/);
      expect(existsSync(only)).toBe(false);
      expect(removeOldSockets(mixed)).toMatch(/holds more than sockets/);
      expect(existsSync(join(mixed, "notes.txt"))).toBe(true);
      expect(removeOldSockets(join(root, "missing"))).toBe("");
    } finally {
      for (const server of servers) server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
