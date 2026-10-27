import { generateKeyPairSync } from "node:crypto";
import { importPKCS8 } from "jose";
import { describe, expect, it, vi } from "vitest";
import { dispatchDeploy, pkcs8Pem } from "./github.ts";

describe("GitHub App key (K-718)", () => {
  it("takes the PKCS #1 key that GitHub gives, and leaves a PKCS #8 key as it is", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(pkcs8Pem(pkcs1).replace(/\s+/g, "")).toBe(pkcs8.replace(/\s+/g, ""));
    await expect(importPKCS8(pkcs8Pem(pkcs1), "RS256")).resolves.toBeDefined();
    expect(pkcs8Pem(pkcs8)).toBe(pkcs8);
  });
  it("reaches the repo by its id only: a token for that id, its current name, then the branch ref", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const calls: Array<{ url: string; body: unknown }> = [];
    // A suspended installation is skipped, two others refuse, and the repo has a new name since its last deploy.
    const answers: Array<Response> = [
      Response.json([{ id: 5, suspended_at: "2026-10-01T00:00:00Z" }, { id: 6 }, { id: 7 }, { id: 42 }]),
      Response.json({ message: "Forbidden" }, { status: 403 }),
      Response.json({ message: "not accessible" }, { status: 422 }),
      Response.json({ token: "t" }),
      Response.json({ total_count: 1, repositories: [{ id: 1001, full_name: "o/renamed" }] }),
      new Response(null, { status: 204 }),
    ];
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error(`No answer for ${String(url)}`);
      return answer;
    });
    await expect(dispatchDeploy({ id: "1", key }, "1001", "main", "kitshn.yml")).resolves.toBe("o/renamed");
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/app/installations?per_page=100",
      "https://api.github.com/app/installations/6/access_tokens",
      "https://api.github.com/app/installations/7/access_tokens",
      "https://api.github.com/app/installations/42/access_tokens",
      "https://api.github.com/installation/repositories",
      "https://api.github.com/repos/o/renamed/actions/workflows/kitshn.yml/dispatches",
    ]);
    expect(calls[3]?.body).toEqual({ repository_ids: [1001], permissions: { actions: "write" } });
    expect(calls[5]?.body).toEqual({ ref: "refs/heads/main" });
  });
});
