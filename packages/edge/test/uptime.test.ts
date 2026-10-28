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
    return new Response("body", { status });
  });

const uptimeOf = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (instance, state) => ({
    row: state.storage.sql
      .exec<{ up: number; failing: number }>(
        "SELECT up, failing_since IS NOT NULL AS failing FROM uptime WHERE card_id = 'shop'",
      )
      .toArray()[0],
    changes: (
      instance as unknown as { uptimeChanges(card: string): ReadonlyArray<UptimeChange> }
    ).uptimeChanges("shop"),
  }));

/** A new turn of 2 minutes, without waiting for it: the turn resets and a first failure moves 3 minutes back. */
const nextTurn = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (instance, state) => {
    state.storage.sql.exec(
      "UPDATE uptime SET failing_since = failing_since - 180000 WHERE failing_since IS NOT NULL",
    );
    const kitshn = instance as unknown as { uptimeSlot: number | null; uptimeCache: unknown };
    kitshn.uptimeSlot = null;
    kitshn.uptimeCache = null;
  });

it("records a static site down when it still fails a turn after its first failure, and up after one good answer (K-1125, K-1126)", async () => {
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
  const failing = site(502);
  await runDurableObjectAlarm(stub);
  expect((await uptimeOf(stub)).row).toEqual({ up: 1, failing: 1 });
  // An early alarm in the same turn fetches nothing, so one short error never counts twice.
  await runDurableObjectAlarm(stub);
  expect(failing).toHaveBeenCalledTimes(1);
  expect((await uptimeOf(stub)).row).toEqual({ up: 1, failing: 1 });
  await nextTurn(stub);
  site(null);
  await runDurableObjectAlarm(stub);
  expect((await uptimeOf(stub)).row).toEqual({ up: 0, failing: 0 });
  await nextTurn(stub);
  site(302);
  await runDurableObjectAlarm(stub);
  const { row, changes } = await uptimeOf(stub);
  // A card that is up again keeps no row; its changes remain.
  expect(row).toBeUndefined();
  expect(changes.map((change) => change.up)).toEqual([false, true]);
});
