import { afterEach, describe, expect, it, vi } from "vitest";
import type { Edit } from "../src/core/changes.ts";
import type { Circle } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

/** K-1116, K-1117: an agent key publishes a page, updates it by name, and the owner restores its previous version. */

const agentCircle = (id: string, clientId: string, x: number, publishes = false): Circle => ({
  id,
  name: id,
  color: "#7c3aed",
  level: "control",
  members: [{ _tag: "device", tokenId: `t-${id}`, clientId, name: id, ...(publishes ? { publishes } : {}) }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y: 2000,
  r: 300,
});

const owner = () => accessToken("admin-aud", { email: "owner@example.com" });
const agent = (clientId: string) => accessToken("agent-aud", { common_name: clientId });

async function apply(edits: ReadonlyArray<Edit>) {
  const answer = await send("/api/apply", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": await owner(), "content-type": "application/json" },
    body: JSON.stringify({ edits }),
  });
  expect(answer.status, await answer.clone().text()).toBe(200);
}

async function publish(
  clientId: string,
  name: string,
  body: string | ReadableStream<Uint8Array>,
  extra: Record<string, string> = {},
) {
  return send("/agent/library", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await agent(clientId),
      "x-kitshn-name": encodeURIComponent(name),
      "content-length": String(typeof body === "string" ? new TextEncoder().encode(body).length : 64),
      ...extra,
    },
    body,
  });
}

const idOf = async (response: Response) => ((await response.json()) as { id: string }).id;

const content = async (id: string) =>
  (
    await send(`/api/library/${id}/content`, { headers: { "cf-access-jwt-assertion": await owner() } })
  ).text();

const state = async () =>
  (await (await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })).json()) as {
    places: Record<string, { x: number; y: number }>;
    previousVersions: ReadonlyArray<string>;
  };

afterEach(() => vi.restoreAllMocks());

describe("agent publish (K-1116, K-1117)", () => {
  it("publishes a page, updates it by name, and keeps one previous version to restore", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);

    const first = await publish("agent-1.access", "design.html", "<html>v1</html>");
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    // No circle: the page waits in the tray, private.
    expect((await state()).places[id]).toBeUndefined();

    const second = await publish("agent-1.access", "design.html", "<html>version two</html>");
    expect(await second.json()).toMatchObject({ id, updated: true });
    expect(await content(id)).toBe("<html>version two</html>");
    expect((await state()).previousVersions).toContain(id);

    const restore = () =>
      owner().then((token) =>
        send(`/api/library/${id}/previous`, {
          method: "POST",
          headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
          body: "{}",
        }),
      );
    expect((await restore()).status).toBe(200);
    expect(await content(id)).toBe("<html>v1</html>");
    // A second restore swaps back.
    expect((await restore()).status).toBe(200);
    expect(await content(id)).toBe("<html>version two</html>");
  });

  it("lands in the agent circle that it names, and another key cannot restore its page", async () => {
    stubAccessCerts();
    await apply([
      { _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) },
      { _tag: "circle", id: "others", after: agentCircle("others", "agent-2.access", 3000) },
    ]);
    const placed = await publish("agent-1.access", "notes.html", "<p>one</p>", {
      "x-kitshn-circle": "agents",
    });
    expect(placed.status).toBe(201);
    const { id } = (await placed.json()) as { id: string };
    const place = (await state()).places[id];
    expect(place && Math.hypot(place.x - 2000, place.y - 2000)).toBeLessThan(300);

    await publish("agent-1.access", "notes.html", "<p>two</p>");
    const foreign = await send(`/agent/library/${id}/previous`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": await agent("agent-2.access") },
    });
    expect(foreign.status).toBe(403);
    // A circle that is not its own refuses the upload before anything lands.
    const refused = await publish("agent-1.access", "other.html", "<p>x</p>", {
      "x-kitshn-circle": "others",
    });
    expect(refused.status).toBe(403);
  });

  it("has no /agent/publish route any more; a public move goes through /agent/apply (K-718)", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);
    const gone = await send("/agent/publish", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await agent("agent-1.access"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ card: "x", public: true }),
    });
    expect(gone.ok).toBe(false);
  });
  it("keeps the served version when an update fails, and gives key B its own card", async () => {
    stubAccessCerts();
    await apply([
      { _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) },
      { _tag: "circle", id: "others", after: agentCircle("others", "agent-2.access", 3000) },
    ]);
    const id = await idOf(await publish("agent-1.access", "kept.html", "<html>v1</html>"));
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>v2"));
        controller.error(new Error("the connection dropped"));
      },
    });
    expect((await publish("agent-1.access", "kept.html", broken)).status).toBe(502);
    expect(await content(id)).toBe("<html>v1</html>");
    expect((await state()).previousVersions).not.toContain(id);

    const other = await publish("agent-2.access", "kept.html", "<html>b</html>");
    expect(other.status).toBe(201);
    expect(await idOf(other)).not.toBe(id);
    expect(await content(id)).toBe("<html>v1</html>");
  });

  it("updates only while the key controls the card, and refuses --circle on an update (K-1117)", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);
    const id = await idOf(
      await publish("agent-1.access", "control.html", "<p>one</p>", { "x-kitshn-circle": "agents" }),
    );
    const moved = await publish("agent-1.access", "control.html", "<p>two</p>", {
      "x-kitshn-circle": "agents",
    });
    expect(moved.status).toBe(409);
    // The owner moves the card out of the agent circle, so the key no longer controls it.
    await apply([{ _tag: "place", id, after: { x: -4000, y: -4000 } }]);
    expect((await publish("agent-1.access", "control.html", "<p>two</p>")).status).toBe(403);
    expect(await content(id)).toBe("<p>one</p>");
  });
  it("refuses an update when the owner moves the tray card during the write, and keeps no stale version", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);
    const id = await idOf(await publish("agent-1.access", "race.html", "<p>one</p>"));
    expect((await publish("agent-1.access", "race.html", "<p>number two</p>")).status).toBe(200);
    const last = new TextEncoder().encode("<p>three</p>");
    let finish = () => {};
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(last);
          controller.close();
        };
      },
    });
    const update = publish("agent-1.access", "race.html", slow, { "content-length": String(last.length) });
    const { circles } = (await (
      await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })
    ).json()) as { circles: ReadonlyArray<Circle> };
    const everyone = circles.find((circle) => circle.id === "everyone");
    if (!everyone) throw new Error("The seed has no Everyone circle.");
    await apply([{ _tag: "place", id, after: { x: everyone.x, y: everyone.y } }]);
    finish();
    expect((await update).status).toBe(403);
    expect(await content(id)).toBe("<p>number two</p>");
    expect((await state()).previousVersions).not.toContain(id);
    // Back in the tray by the owner, the card stays out of the key's reach.
    await apply([{ _tag: "place", id, after: null }]);
    expect((await publish("agent-1.access", "race.html", "<p>four</p>")).status).toBe(403);
  });

  // Last: the Durable Object keeps its state across the tests of this file, and only a passkey resumes.
  it("refuses a new public page during a keep-public pause (K-1504)", async () => {
    stubAccessCerts();
    await apply([
      { _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000, true) },
    ]);
    // Everyone sits next to the agent circle, so the two overlap.
    const everyone = (await (
      await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })
    ).json()) as { circles: ReadonlyArray<Circle> };
    const open = everyone.circles.find((circle) => circle.id === "everyone");
    if (!open) throw new Error("The seed has no Everyone circle.");
    await apply([
      { _tag: "circle", id: "everyone", after: { ...open, x: 2400, y: 2000, r: 300 } },
      { _tag: "pause", after: "keep-public" },
    ]);
    const refused = await publish("agent-1.access", "open.html", "<p>open</p>", {
      "x-kitshn-public": "true",
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await state())).not.toContain("open.html");
  });
});
