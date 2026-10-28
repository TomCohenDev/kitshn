import { describe, expect, it } from "vitest";
import { zoneFor, zoneOfAddressIn, zonesOf } from "./zones.ts";

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
