import { describe, expect, it } from "vitest";
import { zoneFor, zonesOf } from "./zones.ts";

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
});
