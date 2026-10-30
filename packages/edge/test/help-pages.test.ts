import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

const shop: Resource = {
  id: "shop",
  kind: "site.static",
  name: "Shop",
  addresses: ["shop.example.com"],
  status: "running",
  group: null,
  machine: null,
};

async function withShop() {
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES ('shop', ?)",
      JSON.stringify(shop),
    );
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO access_objects (key, cf_id, aud, body, tried, error)
       VALUES ('app:shop:shop.example.com', 'cf-shop', 'aud-shop', '{}', '{}', NULL),
              ('app:ask:help', 'cf-ask', 'ask-aud', '{}', '{}', NULL)`,
    );
    state.storage.sql.exec("DELETE FROM notifications WHERE source = 'access'");
    const kitshn = instance as unknown as {
      load(): void;
      accessCache: unknown;
      openNotificationsCache?: unknown;
    };
    kitshn.accessCache = null;
    kitshn.load();
  });
}

it("shows a stranger a kitshn page with no ask, and links only to an https address on the zone (K-1132)", async () => {
  await withShop();
  const page = await send("/public/help/denied?kid=aud-shop&original_url=shop.example.com%2Fcart");
  expect(page.status).toBe(403);
  const html = await page.text();
  expect(html).toContain("Shop");
  expect(html).toContain('href="https://shop.example.com/cart"');
  // Only people whom a circle lets in reach `/ask` (K-111), so this page offers no ask.
  expect(html).not.toContain("/ask");
  expect(html).toContain("Ask the person who sent you this link to add your email.");
  for (const original of [
    "evil.test?.example.com",
    "evil.test#.example.com",
    "evil.test\\@a.example.com",
    "http://shop.example.com/x",
  ]) {
    const foreign = await (
      await send(`/public/help/denied?kid=aud-shop&original_url=${encodeURIComponent(original)}`)
    ).text();
    expect(foreign, original).not.toContain("Open it again");
  }
  // A refusal on `/ask` itself carries the card's refusal in its own address.
  const nested = encodeURIComponent("kit.example.com/ask?kid=aud-shop&original_url=shop.example.com%2Fcart");
  expect(await (await send(`/public/help/denied?kid=ask-aud&original_url=${nested}`)).text()).toContain(
    "Shop",
  );
});

it("shows a known person the refusal with Ask for access, and opens one Inbox item (K-1132)", async () => {
  stubAccessCerts();
  await withShop();
  const token = await accessToken("ask-aud", { email: "friend@example.org" });
  const shown = await send("/ask?kid=aud-shop&original_url=shop.example.com", {
    headers: { "cf-access-jwt-assertion": token },
  });
  const html = await shown.text();
  expect(html).toContain("friend@example.org");
  expect(html).toContain("Ask for access");
  const ask = async () =>
    send("/ask", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": token,
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://kit.example.com",
      },
      body: "kid=aud-shop",
    });
  expect((await ask()).status).toBe(200);
  expect((await ask()).status).toBe(200);
  const rows = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql
      .exec<{ title: string; state: string }>(
        "SELECT title, state FROM notifications WHERE source = 'access'",
      )
      .toArray(),
  );
  expect(rows).toEqual([{ title: "friend@example.org asks for access to Shop", state: "open" }]);
  // A token of another application, or none, is no ask.
  const other = await accessToken("admin-aud", { email: "friend@example.org" });
  for (const headers of [{}, { "cf-access-jwt-assertion": other }]) {
    const refused = await send("/ask", {
      method: "POST",
      headers: { ...headers, origin: "https://kit.example.com" },
      body: "kid=aud-shop",
    });
    expect(refused.status).toBe(401);
  }
});
