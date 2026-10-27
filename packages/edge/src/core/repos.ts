/** K-819: whether a repo may deploy. A repo that kitshn has never seen waits for the owner. */
export type RepoState = "waiting" | "allowed" | "blocked";

export interface RepoGate {
  /** The GitHub `repository_id`, which a rename or a transfer keeps. */
  readonly repoId: string;
  readonly name: string;
  readonly state: RepoState;
  readonly firstSeen: number;
  /** The first pushed branch that waits; Allow starts the workflow there. Null without a waiting push. */
  readonly branch: string | null;
}

/**
 * K-819: the answer to one deploy step of a repo, and the gate row to write, or null when it stays.
 * A repo without a row waits. A waiting repo keeps its first pushed branch; an allowed repo that deploys
 * needs no start from Allow anymore.
 */
export function gateDecision(
  gate: RepoGate | undefined,
  repo: { readonly repoId: string; readonly name: string; readonly branch: string | null },
  now: number,
):
  | { readonly allow: true; readonly record: RepoGate | null }
  | { readonly allow: false; readonly record: RepoGate | null; readonly error: string } {
  if (!gate)
    return { allow: false, record: { ...repo, state: "waiting", firstSeen: now }, error: waiting(repo.name) };
  const next: RepoGate = {
    ...gate,
    name: repo.name,
    branch: gate.state === "waiting" ? (gate.branch ?? repo.branch) : null,
  };
  const record = next.name !== gate.name || next.branch !== gate.branch ? next : null;
  switch (gate.state) {
    case "allowed":
      return { allow: true, record };
    case "blocked":
      return { allow: false, record, error: `The owner blocked deploys of ${repo.name} on the kitshn map.` };
    case "waiting":
      return { allow: false, record, error: waiting(repo.name) };
  }
}

const waiting = (name: string) =>
  `kitshn has not deployed ${name} before. It waits on the kitshn map until the owner allows it.`;
