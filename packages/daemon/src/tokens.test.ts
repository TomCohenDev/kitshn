import { describe, expect, it } from "vitest";
import { TokenCache } from "./tokens.ts";

const hour = (now: number) => new Date(now + 3_600_000).toISOString();

describe("kept GitHub tokens (K-1762)", () => {
  it("answers only the same repo and thread, and a read token never answers write or auto", () => {
    const cache = new TokenCache();
    cache.set("Owner/Repo", "t1", { token: "r", expiresAt: hour(0), permission: "read" });
    expect(cache.get("owner/repo", "t1", "read", 0)?.token).toBe("r");
    expect(cache.get("owner/repo", "t2", "read", 0)).toBeNull();
    expect(cache.get("owner/repo", "t1", "write", 0)).toBeNull();
    expect(cache.get("owner/repo", "t1", "auto", 0)).toBeNull();
    cache.set("owner/repo", "t1", { token: "w", expiresAt: hour(0), permission: "write" });
    expect(cache.get("owner/repo", "t1", "auto", 0)?.token).toBe("w");
    // 5 minutes before it expires, a token goes back to kitshn.
    expect(cache.get("owner/repo", "t1", "write", 3_600_000 - 5 * 60_000)).toBeNull();
  });

  it("drops one repo, also written in another case, or every token", () => {
    const cache = new TokenCache();
    cache.set("owner/a", "t", { token: "a", expiresAt: hour(0), permission: "write" });
    cache.set("owner/ab", "t", { token: "ab", expiresAt: hour(0), permission: "write" });
    cache.drop("Owner/A");
    expect(cache.get("owner/a", "t", "write", 0)).toBeNull();
    expect(cache.get("owner/ab", "t", "write", 0)?.token).toBe("ab");
    cache.drop(null);
    expect(cache.get("owner/ab", "t", "write", 0)).toBeNull();
  });
});
