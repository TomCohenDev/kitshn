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
  it("asks for a token for one repo and Actions only, then dispatches the branch ref", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const calls: Array<{ url: string; body: unknown }> = [];
    const answers = [{ id: 42 }, { token: "t" }, null];
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      const answer = answers[calls.length - 1];
      return answer === null ? new Response(null, { status: 204 }) : Response.json(answer);
    });
    await dispatchDeploy({ id: "1", key }, "o/app", "main", "kitshn.yml");
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/o/app/installation",
      "https://api.github.com/app/installations/42/access_tokens",
      "https://api.github.com/repos/o/app/actions/workflows/kitshn.yml/dispatches",
    ]);
    expect(calls[1]?.body).toEqual({ repositories: ["app"], permissions: { actions: "write" } });
    expect(calls[2]?.body).toEqual({ ref: "refs/heads/main" });
  });
});
