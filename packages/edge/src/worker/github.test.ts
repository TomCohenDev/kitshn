import { generateKeyPairSync } from "node:crypto";
import { importPKCS8 } from "jose";
import { describe, expect, it } from "vitest";
import { pkcs8Pem } from "./github.ts";

describe("GitHub App key (K-718)", () => {
  it("takes the PKCS #1 key that GitHub gives, and leaves a PKCS #8 key as it is", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(pkcs8Pem(pkcs1).replace(/\s+/g, "")).toBe(pkcs8.replace(/\s+/g, ""));
    await expect(importPKCS8(pkcs8Pem(pkcs1), "RS256")).resolves.toBeDefined();
    expect(pkcs8Pem(pkcs8)).toBe(pkcs8);
  });
});
