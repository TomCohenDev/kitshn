import { describe, expect, it } from "vitest";
import { removeStaleDomains, zoneFor, zoneOfAddressIn, zonesOf } from "./zones.ts";

const env = { KITSHN_ZONE: "example.com", CLOUDFLARE_ZONE_ID: "z1" };

describe("zones (K-1111, K-817)", () => {
  it("lists the kitshn zone first, then KITSHN_ZONES", () => {
    expect(zonesOf(env)).toEqual([{ name: "example.com", id: "z1" }]);
    expect(zonesOf({ ...env, KITSHN_ZONES: '{"onion-climbers.com":"z2"}' })).toEqual([
      { name: "example.com", id: "z1" },
      { name: "onion-climbers.com", id: "z2" },
    ]);
    expect(() => zonesOf({ ...env, KITSHN_ZONES: '["onion-climbers.com"]' })).toThrow();
    expect(() => zonesOf({ ...env, KITSHN_ZONES: '{"onion-climbers.com":""}' })).toThrow();
  });

  it("finds the zone of the apex and of one name under it, and none deeper or outside", () => {
    const zones = zonesOf({ ...env, KITSHN_ZONES: '{"onion-climbers.com":"z2"}' });
    expect(zoneFor("www.onion-climbers.com", zones)?.id).toBe("z2");
    expect(zoneFor("onion-climbers.com", zones)?.id).toBe("z2");
    expect(zoneFor("climbing.example.com", zones)?.id).toBe("z1");
    expect(zoneFor("a.b.example.com", zones)).toBeNull();
    expect(zoneFor("other.org", zones)).toBeNull();
  });

  it("refuses look-alike, trailing-dot and uppercase names, and takes the longest zone", () => {
    const zones = zonesOf({ ...env, KITSHN_ZONES: '{"onion-climbers.com":"z2","lab.example.com":"z3"}' });
    expect(zoneFor("evilexample.com", zones)).toBeNull();
    expect(zoneFor("x.example.com.", zones)).toBeNull();
    expect(zoneFor("X.example.com", zones)).toBeNull();
    expect(zoneFor("lab.example.com", zones)?.id).toBe("z3");
    expect(zoneFor("a.lab.example.com", zones)?.id).toBe("z3");
  });

  it("keeps the kitshn zone working when KITSHN_ZONES is broken", () => {
    const broken = { ...env, KITSHN_ZONES: "not json" };
    expect(zoneOfAddressIn("climbing.example.com", broken)?.id).toBe("z1");
    expect(() => zoneOfAddressIn("onion-climbers.com", broken)).toThrow();
  });
});

describe("zone lookup on the real zone names (K-817)", () => {
  it("refuses evilyarden-zamir.com, a trailing dot and uppercase", () => {
    const zones = zonesOf({
      KITSHN_ZONE: "yarden-zamir.com",
      CLOUDFLARE_ZONE_ID: "z1",
      KITSHN_ZONES: '{"onion-climbers.com":"z2"}',
    });
    expect(zoneFor("evilyarden-zamir.com", zones)).toBeNull();
    expect(zoneFor("climbing.yarden-zamir.com.", zones)).toBeNull();
    expect(zoneFor("Climbing.yarden-zamir.com", zones)).toBeNull();
    expect(zoneFor("climbing.yarden-zamir.com", zones)?.id).toBe("z1");
    expect(zoneFor("www.onion-climbers.com", zones)?.id).toBe("z2");
  });
});

describe("stale custom domains of a static site (K-817, K-410)", () => {
  const fakeApi = (attached: Array<{ id: string; hostname: string }>, keep = false) => {
    const calls: Array<string> = [];
    const api = (<T>(method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (method === "DELETE" && !keep)
        attached.splice(
          attached.findIndex((domain) => path.endsWith(domain.id)),
          1,
        );
      return Promise.resolve((method === "GET" ? [...attached] : null) as T);
    }) as Parameters<typeof removeStaleDomains>[0];
    return { api, calls };
  };

  it("deletes only the domains that left the list, then reads again to confirm", async () => {
    const { api, calls } = fakeApi([
      { id: "d1", hostname: "a.example.com" },
      { id: "d2", hostname: "old.example.com" },
    ]);
    await removeStaleDomains(api, "/accounts/x", "kitshn-app", ["a.example.com"]);
    expect(calls).toEqual([
      "GET /accounts/x/workers/domains?service=kitshn-app",
      "DELETE /accounts/x/workers/domains/d2",
      "GET /accounts/x/workers/domains?service=kitshn-app",
    ]);
  });

  it("fails while a stale domain still serves, so the card keeps its address and Access application", async () => {
    const { api } = fakeApi([{ id: "d2", hostname: "old.example.com" }], true);
    await expect(removeStaleDomains(api, "/accounts/x", "kitshn-app", ["a.example.com"])).rejects.toThrow(
      "old.example.com",
    );
  });
});
