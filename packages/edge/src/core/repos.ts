/** K-819: whether a repo may deploy. A repo that kitshn has never seen waits for the owner. */
export type RepoState = "waiting" | "allowed" | "blocked";

export interface RepoGate {
  /** The GitHub `repository_id`, which a rename or a transfer keeps. */
  readonly repoId: string;
  readonly name: string;
  readonly state: RepoState;
  readonly firstSeen: number;
}

/**
 * K-819: the answer to one deploy step of a repo. `seenBefore` means kitshn deployed a repo of this name
 * before the gate existed, which counts as allowed once and then keeps the id.
 */
export function gateDecision(
  gate: RepoGate | undefined,
  repo: { readonly repoId: string; readonly name: string },
  seenBefore: boolean,
  now: number,
): { readonly allow: true; readonly record: RepoGate | null } | { readonly allow: false; readonly record: RepoGate | null; readonly error: string } {
  if (gate?.state === "allowed") return { allow: true, record: null };
  if (gate?.state === "blocked")
    return { allow: false, record: null, error: `The owner blocked deploys of ${repo.name} on the kitshn map.` };
  if (gate?.state === "waiting")
    return { allow: false, record: null, error: waiting(repo.name) };
  const record: RepoGate = { repoId: repo.repoId, name: repo.name, state: seenBefore ? "allowed" : "waiting", firstSeen: now };
  return seenBefore ? { allow: true, record } : { allow: false, record, error: waiting(repo.name) };
}

const waiting = (name: string) =>
  `kitshn has not deployed ${name} before. It waits on the kitshn map until the owner allows it; then run this workflow again.`;
