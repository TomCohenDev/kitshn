import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { newMachineKey } from "../src/core/machine.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { forwarded, setup } from "./machine-http.ts";

afterEach(() => vi.restoreAllMocks());

it("takes a call that the daemon forwarded and signed, with the right of its path, once per nonce (K-1714)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  await setup({ deploys: { mode: "automatic" } }, key);
  const address = "/agent/cards/no-such-card/address";
  const off = await forwarded(key, "POST", address, "nonce-off-0123456789");
  expect(off.status).toBe(403);
  // A forwarded call cannot wait for the Owner, so an unset right refuses it too, and says how to fix it.
  expect(await off.json()).toEqual({
    error: expect.stringContaining('"adds pages" is not set'),
    need: "addsPages",
  });
  await setup({ deploys: { mode: "automatic" }, addsPages: { mode: "automatic" } }, key);
  const passed = await forwarded(
    key,
    "POST",
    address,
    "nonce-on-01234567890",
    JSON.stringify({ address: "x" }),
  );
  // The right passes; the path itself answers for the unknown card.
  expect((await passed.json()) as { error?: string }).toEqual({
    error: expect.not.stringMatching(/K-1714|adds pages/),
  });
  // A path that decodes out of a card, or out of /agent/, never reaches a route (K-1714).
  for (const [index, path] of [
    "/agent/cards/a%2f..%2f..%2fconnect/address",
    "/agent/cards/a%252e%252e/address",
  ].entries()) {
    const climbing = await forwarded(key, "POST", path, `nonce-climb-${index}-0123456789`);
    expect(climbing.status, path).toBe(403);
    expect(await climbing.json()).toEqual({ error: expect.stringContaining("forwards no call") });
  }
  // The used nonce stays in storage, so a restart of the object does not let a copied call run again.
  await evictDurableObject(env.KITSHN.getByName("kitshn"));
  const again = await forwarded(key, "POST", address, "nonce-on-01234567890");
  expect(again.status).toBe(403);
  expect(await again.json()).toEqual({ error: expect.stringContaining("nonce") });
  const events = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql
      .exec<{ action: string; target: string }>("SELECT action, target FROM ask_events ORDER BY id")
      .toArray(),
  );
  // A call whose signature or nonce fails is no call of the machine, so it writes no event.
  expect(events).toEqual([{ action: "forward", target: `POST ${address}` }]);
});

it("refuses the machine's own token on every agent path over HTTP without the daemon's signature (K-1714)", async () => {
  stubAccessCerts();
  await setup({ runsCommands: { mode: "automatic" }, deploys: { mode: "automatic" } });
  const token = await accessToken("agent-aud", { common_name: "vps.access" });
  const headers = { "cf-access-jwt-assertion": token, "content-type": "application/json" };
  for (const [method, path] of [
    ["GET", "/agent/state"],
    ["POST", "/agent/apply"],
    ["POST", "/agent/jobs"],
    ["GET", "/agent/jobs/1"],
    ["POST", "/agent/deploy"],
    ["POST", "/agent/repos/123"],
    ["POST", "/agent/library"],
  ] as const) {
    const response = await send(path, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
    expect(response.status, path).toBe(403);
  }
});
