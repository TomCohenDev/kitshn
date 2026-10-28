import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Resource } from "../src/core/model.ts";
import type { UptimeChange } from "../src/core/uptime.ts";

afterEach(() => vi.restoreAllMocks());

/** The site answers `status`, or nothing when it is null. */
const site = (status: number | null) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://shop.example.com/") throw new Error(`Unexpected fetch: ${url}`);
    if (status === null) throw new Error("timeout");
    return new Response(null, { status });
  });

const uptimeOf = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (instance, state) => ({
    row: state.storage.sql.exec<{ up: number }>("SELECT up FROM uptime WHERE card_id = 'shop'").toArray()[0],
    changes: (
      instance as unknown as { uptimeChanges(card: string): ReadonlyArray<UptimeChange> }
    ).uptimeChanges("shop"),
  }));

it("records a static site down after two failed checks and up after one good one (K-1125)", async () => {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (instance, state) => {
    const shop: Resource = {
      id: "shop",
      kind: "site.static",
      name: "shop",
      addresses: ["shop.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    state.storage.sql.exec("INSERT INTO resources (id, body) VALUES ('shop', ?)", JSON.stringify(shop));
    (instance as unknown as { load(): void }).load();
  });
  site(502);
  await runDurableObjectAlarm(stub);
  expect((await uptimeOf(stub)).row?.up).toBe(1);
  site(null);
  await runDurableObjectAlarm(stub);
  expect((await uptimeOf(stub)).row?.up).toBe(0);
  site(302);
  await runDurableObjectAlarm(stub);
  const { row, changes } = await uptimeOf(stub);
  expect(row?.up).toBe(1);
  expect(changes.map((change) => change.up)).toEqual([true, false, true]);
});
