// Section 7: the cards of a machine's providers (K-704, K-705) and the grant tables that kitshn pushes to them (K-706).
import type { Grant, GrantRule, GrantTables, ProviderCommand, ProviderReport } from "@kitshn/local";
import type { Machine } from "./machine.ts";
import {
  type Member,
  type Resource,
  type State,
  activeShares,
  levelName,
  providerCardId,
  shareKey,
} from "./model.ts";

/**
 * K-705: the cards that the reports of one machine describe, by card id. A card of a provider that is not online
 * shows "offline" (K-304). `zone` makes the address of a card with a site (K-1104).
 */
export function providerCards(
  machine: Pick<Machine, "id">,
  reports: ReadonlyArray<ProviderReport>,
  zone: string,
): Map<string, Resource> {
  const cards = new Map<string, Resource>();
  for (const report of reports) {
    const kinds = new Map(report.kinds.map((kind) => [kind.id, kind]));
    for (const item of report.resources) {
      const kind = kinds.get(item.kind);
      if (!kind) continue;
      const id = providerCardId(machine.id, report.name, item.id);
      cards.set(id, {
        id,
        kind: item.kind as Resource["kind"],
        name: item.name,
        addresses: item.site ? [`${item.site.name}.${zone}`] : [],
        status: report.online ? item.status : "offline",
        // K-508: a resource stacks with the card of its parent.
        group: item.parent === undefined ? null : providerCardId(machine.id, report.name, item.parent),
        machine: machine.id,
        provider: {
          name: report.name,
          localId: item.id,
          kindName: kind.name,
          levels: kind.levels,
          facts: item.facts ?? [],
          stickers: item.stickers ?? [],
          site: item.site?.name ?? null,
        },
      });
    }
  }
  return cards;
}

const ruleOf = (member: Member, machines: ReadonlyMap<string, Machine>): GrantRule | null => {
  switch (member._tag) {
    case "email":
      return { email: member.email.toLowerCase() };
    case "domain":
      return { domain: member.domain.toLowerCase() };
    case "ip":
      return { ip: member.range };
    case "device":
      return { device: { clientId: member.clientId, name: member.name } };
    case "machine": {
      const machine = machines.get(member.machineId);
      return machine ? { machine: { machineId: machine.id, clientId: machine.clientId } } : null;
    }
    case "everyone":
      return { everyone: true };
  }
};

/**
 * K-706: the grants of one card: each share that gives access now, with the provider's name of its level. A pause
 * closes every share of a provider card (K-1504, K-1618), and an end date ends one (K-209). A circle with "all must
 * match" that names a machine kitshn does not know gets no grant, because dropping that rule would widen it (K-006).
 */
export function grantsOf(state: State, card: Resource, now: number): Array<Grant> {
  const grants: Array<Grant> = [];
  for (const share of activeShares(state, card, now)) {
    const { circle } = share;
    const known = circle.members.map((member) => ruleOf(member, state.machines));
    if (circle.match === "all" && known.includes(null)) continue;
    const rules = known.filter((rule) => rule !== null);
    if (rules.length === 0) continue;
    const shareEnds = state.shareSettings.get(shareKey(card.id, circle.id))?.endsAt ?? null;
    const ends = [circle.endsAt, shareEnds].filter((time) => time !== null);
    grants.push({
      circle: {
        id: circle.id,
        name: circle.name,
        match: circle.match,
        needsPasskey: circle.needsPasskey,
        rules,
      },
      level: levelName(card, share.level),
      endsAt: ends.length === 0 ? null : Math.min(...ends),
    });
  }
  return grants;
}

/** K-706: the grant table of each card of one provider of a machine, by the provider's own id of the resource. */
export function grantTables(state: State, machineId: string, provider: string, now: number): GrantTables {
  const tables: Record<string, Array<Grant>> = {};
  for (const card of state.resources.values())
    if (card.machine === machineId && card.provider?.name === provider)
      tables[card.provider.localId] = grantsOf(state, card, now);
  return tables;
}

/** K-707: the commands of a machine's providers that fit one card, or the commands of the machine card. */
export function commandsFor(
  providers: ReadonlyArray<Pick<ProviderReport, "name" | "commands">>,
  card: Pick<Resource, "kind" | "provider">,
): Array<{ readonly provider: string; readonly command: ProviderCommand }> {
  return providers.flatMap((report) =>
    report.commands
      .filter((command) =>
        card.provider
          ? card.provider.name === report.name && command.kinds.includes(card.kind)
          : card.kind === "machine" && command.kinds.length === 0,
      )
      .map((command) => ({ provider: report.name, command })),
  );
}
