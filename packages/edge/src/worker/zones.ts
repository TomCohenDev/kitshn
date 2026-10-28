import { zoneOfAddress } from "kitshn/recipe";
import type { Env } from "./env.ts";

export interface Zone {
  readonly name: string;
  readonly id: string;
}

/**
 * K-1111, K-817: the zones that kitshn publishes on, the kitshn zone first. A broken KITSHN_ZONES fails, so kitshn
 * never guesses a zone (K-006).
 */
export function zonesOf(env: Pick<Env, "KITSHN_ZONE" | "CLOUDFLARE_ZONE_ID" | "KITSHN_ZONES">): Array<Zone> {
  const main = { name: env.KITSHN_ZONE, id: env.CLOUDFLARE_ZONE_ID };
  if (!env.KITSHN_ZONES) return [main];
  const parsed: unknown = JSON.parse(env.KITSHN_ZONES);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("KITSHN_ZONES is not a JSON object of zone names and ids.");
  const others = Object.entries(parsed).map(([name, id]) => {
    if (typeof id !== "string" || id === "" || name === "")
      throw new Error(`KITSHN_ZONES has no id for ${name}.`);
    return { name, id };
  });
  return [main, ...others.filter((zone) => zone.name !== main.name)];
}

/** K-817: the zone of an address, or null when kitshn does not publish there. */
export function zoneFor(address: string, zones: ReadonlyArray<Zone>): Zone | null {
  const name = zoneOfAddress(
    address,
    zones.map((zone) => zone.name),
  );
  return zones.find((zone) => zone.name === name) ?? null;
}
