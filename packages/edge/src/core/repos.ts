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
  /** The agent key that allowed the repo (K-718), or null when the owner allowed it or nobody did yet. */
  readonly allowedBy: AllowingAgent | null;
}

export interface AllowingAgent {
  readonly clientId: string;
  /** The member name of the key when it allowed the repo. */
  readonly name: string;
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
  /** The agent key that allowed the repo has no agent circle anymore (keyRemoved); the repo then waits. */
  removed = false,
):
  | { readonly allow: true; readonly record: RepoGate | null }
  | { readonly allow: false; readonly record: RepoGate | null; readonly error: string } {
  if (!gate)
    return {
      allow: false,
      record: { ...repo, state: "waiting", firstSeen: now, allowedBy: null },
      error: waiting(repo.name),
    };
  const next: RepoGate = {
    ...gate,
    name: repo.name,
    branch: gate.state === "waiting" || removed ? (gate.branch ?? repo.branch) : null,
  };
  const record = next.name !== gate.name || next.branch !== gate.branch ? next : null;
  switch (gate.state) {
    case "allowed":
      return removed
        ? {
            allow: false,
            record,
            error: `The agent key that allowed ${repo.name} is gone. The repo waits on the kitshn map until the owner takes it over.`,
          }
        : { allow: true, record };
    case "blocked":
      return { allow: false, record, error: `The owner blocked deploys of ${repo.name} on the kitshn map.` };
    case "waiting":
      return { allow: false, record, error: waiting(repo.name) };
  }
}

const waiting = (name: string) =>
  `kitshn has not deployed ${name} before. It waits on the kitshn map until the owner allows it.`;

/**
 * K-819: a repo that an agent key allowed waits again while that key has no agent circle, for example after
 * the owner removed the key. This fails closed until the owner takes the repo over or blocks it.
 */
export const keyRemoved = (gate: RepoGate, hasAgentCircle: (clientId: string) => boolean) =>
  gate.state === "allowed" && gate.allowedBy !== null && !hasAgentCircle(gate.allowedBy.clientId);

/**
 * K-819: why an agent key may not allow this repo, with the HTTP status, or null. It needs the right "adds
 * apps" (K-718) and allows only a waiting repo: it never unblocks a blocked repo or takes over an allowed one.
 */
export function agentAllowRefusal(
  gate: RepoGate | undefined,
  state: unknown,
  addsApps: boolean,
): { readonly status: 400 | 403 | 404 | 409; readonly error: string } | null {
  if (state !== "allowed") return { status: 400, error: 'Send {"state": "allowed"}.' };
  if (!addsApps)
    return { status: 403, error: "This key may not add apps. The owner turns on \"may add apps\" for it (K-718)." };
  if (!gate) return { status: 404, error: "kitshn knows no such repo. Its first deploy step records it (K-819)." };
  if (gate.state !== "waiting")
    return { status: 409, error: `${gate.name} is ${gate.state}; an agent key allows only a waiting repo (K-819).` };
  return null;
}

/**
 * K-819: why the owner may not forget this repo, or null. A forgotten repo waits again on its next deploy. A
 * repo with cards keeps its row, so each card keeps its "Deploys" switch and its agent redeploys stay refused
 * for the right reason; the owner removes the apps first (K-909). A blocked repo is forgotten only once GitHub
 * deleted it: otherwise its next deploy would wait, and an agent key with "adds apps" could then allow a repo
 * that the owner blocked.
 */
export function forgetRefusal(
  repo: { readonly name: string; readonly state: RepoState; readonly goneOnGitHub: boolean },
  cards: number,
): string | null {
  if (cards > 0)
    return `${repo.name} still deploys ${cards === 1 ? "1 app" : `${cards} apps`}. Remove ${cards === 1 ? "it" : "them"} with "Remove app" first (K-909), then forget the repo.`;
  if (repo.state === "blocked" && !repo.goneOnGitHub)
    return `${repo.name} is blocked. Allow it first if you want it to wait again; a blocked repo is forgotten only after GitHub deleted it (K-819).`;
  return null;
}

/**
 * K-819: the toolbar counts a repo as waiting only while the owner can allow it. A repo of a removed key needs
 * Take over, and a repo that GitHub deleted can only be forgotten.
 */
export const awaitsAllow = (repo: {
  readonly state: RepoState;
  readonly keyRemoved: boolean;
  readonly goneOnGitHub: boolean;
}) => repo.state === "waiting" && !repo.keyRemoved && !repo.goneOnGitHub;
