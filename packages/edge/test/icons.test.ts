import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import { liveSiteId } from "../src/worker/live.ts";

const png = (last: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, last]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A daemon socket of a machine that passed its key check (K-1704). */
const daemonSocket = (machineId: string) =>
  ({
    deserializeAttachment: () => ({
      kind: "machine",
      machineId,
      since: 0,
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    }),
    serializeAttachment() {},
    send() {},
    close() {},
  }) as unknown as WebSocket;

const machine = (id: string): Machine => ({
  id,
  name: id,
  labels: [],
  order: 0,
  serviceTokenId: `token-${id}`,
  clientId: `${id}.access`,
  tunnelId: `tunnel-${id}`,
});

it("stores the icon that a daemon reads from its own site, at most one change an hour (K-1114)", async () => {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    for (const id of ["m1", "m2"])
      state.storage.sql.exec(
        "INSERT INTO machines (id, body) VALUES (?, ?)",
        id,
        JSON.stringify(machine(id)),
      );
  });
  // The Durable Object reads the machines again when it starts.
  await evictDurableObject(stub);
  const send = (machineId: string, message: object) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket(machineId), JSON.stringify(message)),
    );
  const stored = () =>
    runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec<{ id: string; hash: string }>("SELECT id, hash FROM icons").toArray(),
    );

  const site = { name: "demo", target: "http://localhost:5173", dev: true, up: true };
  const fresh = { ...site, name: "fresh", target: "http://localhost:5174" };
  await send("m1", { type: "sites", sites: [site, fresh] });
  await send("m1", { type: "icon", site: "demo", icon: base64(png(1)) });
  const [first] = await stored();
  expect(first?.id).toBe(liveSiteId("m1", "demo"));

  // Another machine cannot set the icon of a site that it does not report; "fresh" has no icon yet, so no
  // hourly limit hides this.
  await send("m2", { type: "icon", site: "fresh", icon: base64(png(2)) });
  // A second change within the hour waits; the daemon sends it again later.
  await send("m1", { type: "icon", site: "demo", icon: base64(png(3)) });
  await send("m1", { type: "icon", site: "demo", icon: null });
  // Not an image: refused, also for a site without an icon.
  await send("m1", { type: "icon", site: "fresh", icon: btoa("<html></html>") });
  expect(await stored()).toEqual([first]);
});
