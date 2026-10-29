import { afterEach, expect, it, vi } from "vitest";
import { newMachineKey } from "../src/core/machine.ts";
import { stubAccessCerts } from "./access.ts";
import { forwarded, setup } from "./machine-http.ts";

afterEach(() => vi.restoreAllMocks());

// Its own file: HTTP probes of one file share a runtime, and a refused upload of another test held this one up.
it("checks the conditions of publishes when a forwarded page goes public (K-1714, K-1754)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  await setup(
    {
      addsPages: { mode: "automatic" },
      publishes: { mode: "automatic", conditions: [{ key: "t3.project.name", values: ["kitshn"] }] },
    },
    key,
  );
  const page = { "x-kitshn-name": "p.html", "content-type": "text/html" };
  const open = await forwarded(key, "POST", "/agent/library", "nonce-public-0123456789", "<p>x</p>", {
    ...page,
    "x-kitshn-public": "true",
  });
  expect(open.status).toBe(403);
  expect(await open.json()).toEqual({ error: expect.stringContaining("t3.project.name") });
});
