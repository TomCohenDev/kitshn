import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathsFor } from "./service.ts";
import { SOCKET_PATH_LIMIT, appSocketFolder, jobSocketFolder, socketPathProblem } from "./sockets.ts";

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
});
