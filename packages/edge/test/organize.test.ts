import { afterEach, describe, expect, it, vi } from "vitest";
import type { Circle } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

/** K-532: Organize through the agent path, as one revision of its own. */

const owner = () => accessToken("admin-aud", { email: "owner@example.com" });
const agent = (clientId: string) => accessToken("agent-aud", { common_name: clientId });

const agentCircle = (id: string, clientId: string, x: number): Circle => ({
  id,
  name: id,
  color: "#7c3aed",
  level: "control",
  members: [{ _tag: "device", tokenId: `t-${id}`, clientId, name: id }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y: 2000,
  r: 300,
});

const post = async (path: string, token: string, body: string, headers: Record<string, string> = {}) =>
  send(path, { method: "POST", headers: { "cf-access-jwt-assertion": token, ...headers }, body });

afterEach(() => vi.restoreAllMocks());

describe("agent organize (K-532)", () => {
  it("organizes the cards that the agent may move as one revision that a later move does not join, and a second run moves nothing", async () => {
    stubAccessCerts();
    const circle = { _tag: "circle", id: "tidy", after: agentCircle("tidy", "tidy.access", 6000) };
    const applied = await post("/api/apply", await owner(), JSON.stringify({ edits: [circle] }), {
      "content-type": "application/json",
    });
    expect(applied.status).toBe(200);
    const ids: Array<string> = [];
    for (const name of ["b.html", "a.html", "c.html"]) {
      const published = await post("/agent/library", await agent("tidy.access"), "<p>page</p>", {
        "x-kitshn-name": name,
        "x-kitshn-circle": "tidy",
        "content-length": "11",
      });
      expect(published.status, await published.clone().text()).toBe(201);
      ids.push(((await published.json()) as { id: string }).id);
    }
    // A people circle also holds one card, so no agent may move it; it stays and the other cards still organize.
    const friends: Circle = {
      ...agentCircle("friends", "", 6150),
      level: "view",
      members: [{ _tag: "email", email: "friend@example.com" }],
      r: 60,
    };
    const shared = await post(
      "/api/apply",
      await owner(),
      JSON.stringify({
        edits: [
          { _tag: "circle", id: "friends", after: friends },
          { _tag: "place", id: ids[2], after: { x: 6150, y: 2000 } },
        ],
      }),
      { "content-type": "application/json" },
    );
    expect(shared.status).toBe(200);
    const organize = async () => {
      const response = await send("/agent/organize", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": await agent("tidy.access"),
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { revision: number | null }).revision;
    };
    const revision = await organize();
    const after = (await (
      await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })
    ).json()) as {
      places: Record<string, { x: number; y: number }>;
      revisions: ReadonlyArray<{ id: number; summary: string }>;
    };
    expect(after.revisions.find((each) => each.id === revision)?.summary).toMatch(
      /^Organize: moved \d+ cards?$/,
    );
    for (const id of ids) {
      const place = after.places[id];
      expect(place && Math.hypot(place.x - 6000, place.y - 2000)).toBeLessThan(300);
    }
    expect(after.places[ids[2] ?? ""]).toEqual({ x: 6150, y: 2000 });
    expect(await organize()).toBeNull();

    const [first] = ids;
    const place = after.places[first ?? ""];
    if (!first || !place) throw new Error("no page");
    const moved = await send("/agent/apply", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await agent("tidy.access"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ edits: [{ _tag: "place", id: first, after: { x: place.x + 5, y: place.y } }] }),
    });
    expect(((await moved.json()) as { revision: number }).revision).not.toBe(revision);
  });
});
