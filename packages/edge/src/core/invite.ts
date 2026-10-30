import type { ProviderClient } from "@kitshn/local";

/** K-720: the slot of a client's `open` link that takes the invite link. */
export const INVITE_URL_SLOT = "{inviteUrl}";

/** K-720: a client's `open` link for one invite; the invite link is URL-encoded, so its `#` becomes `%23`. */
export const openLink = (template: string, inviteUrl: string) =>
  template.replaceAll(INVITE_URL_SLOT, encodeURIComponent(inviteUrl));

/** K-720: a client app as the invite shows it, with the provider and the machines that declare it. */
export interface InviteClient extends ProviderClient {
  readonly provider: string;
  readonly machines: ReadonlyArray<string>;
}

/**
 * K-720: the client apps of every machine. Equal declarations merge and list each machine; a client of the same id with
 * other values stays apart with its own machines. `agree` is true when every machine that declares clients declares the
 * same ones, so the invite dialog may open on the first client instead of the plain link.
 */
export function inviteClients(
  declared: ReadonlyArray<{
    readonly machine: string;
    readonly provider: string;
    readonly clients: ReadonlyArray<ProviderClient>;
  }>,
): { readonly clients: ReadonlyArray<InviteClient>; readonly agree: boolean } {
  const found = new Map<string, InviteClient>();
  const lists = new Map<string, Array<string>>();
  for (const { machine, provider, clients } of declared)
    for (const client of clients) {
      const key = JSON.stringify([provider, client]);
      const known = found.get(key);
      found.set(key, { ...client, provider, machines: [...(known?.machines ?? []), machine] });
      lists.set(machine, [...(lists.get(machine) ?? []), key]);
    }
  const shapes = new Set([...lists.values()].map((keys) => JSON.stringify([...keys].sort())));
  return { clients: [...found.values()], agree: shapes.size <= 1 };
}
