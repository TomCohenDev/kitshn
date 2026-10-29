import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { discovery, jwks, newPassKey, RETIRED_MS, signPass } from "./passes.ts";

describe("passes for outside services (K-1770 to K-1772)", () => {
  it("signs a 5-minute pass that a standard library checks against the JWKS", async () => {
    const key = await newPassKey(0);
    const now = Date.now();
    const { pass } = await signPass(
      key,
      {
        issuer: "https://kitshn.example.com",
        audience: "https://api.example.com",
        machineId: "vps",
        labels: null,
      },
      now,
    );
    const set = createLocalJWKSet(jwks([key], now));
    const { payload } = await jwtVerify(pass, set, {
      issuer: "https://kitshn.example.com",
      audience: "https://api.example.com",
    });
    expect(payload.sub).toBe("machine:vps");
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
    expect(payload["act"]).toBeUndefined();
    expect(jwks([key], now).keys[0]).not.toHaveProperty("d");
  });

  it("names the thread only when the audience takes labels", async () => {
    const key = await newPassKey(0);
    const { pass } = await signPass(
      key,
      { issuer: "https://k", audience: "https://a", machineId: "vps", labels: { "t3.thread.id": "abc" } },
      Date.now(),
    );
    const { payload } = await jwtVerify(pass, createLocalJWKSet(jwks([key], Date.now())), {
      audience: "https://a",
    });
    expect(payload["act"]).toEqual({ sub: "t3:abc" });
    expect(payload["kitshn_labels"]).toEqual({ "t3.thread.id": "abc" });
  });

  it("keeps a retired key in the JWKS for 6 minutes, and names its keys in discovery", async () => {
    const old = { ...(await newPassKey(0)), retiredAt: 1000 };
    expect(jwks([old], 1000 + RETIRED_MS - 1).keys).toHaveLength(1);
    expect(jwks([old], 1000 + RETIRED_MS).keys).toHaveLength(0);
    expect(discovery("https://kitshn.example.com").jwks_uri).toBe(
      "https://kitshn.example.com/.well-known/jwks.json",
    );
  });
});
