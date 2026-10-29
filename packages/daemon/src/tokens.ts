// K-1762: the GitHub tokens that the daemon keeps in memory, never on disk, by repo and attested thread.

export interface KeptToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly permission: "read" | "write";
}

/** A kept token answers until 5 minutes before it expires. */
const MARGIN_MS = 5 * 60_000;

/** GitHub names are not case sensitive, so kitshn and git may write one repo in two ways. */
const keyOf = (repo: string, thread: string) => `${repo.toLowerCase()}\n${thread}`;

export class TokenCache {
  private readonly kept = new Map<string, KeptToken>();

  /**
   * The kept token of this repo and thread for the permission that the ask wants. A read token never answers "write"
   * or "auto", because "auto" asks kitshn for write when the machine may write (K-1763).
   */
  get(repo: string, thread: string, wanted: unknown, now: number): KeptToken | null {
    const kept = this.kept.get(keyOf(repo, thread));
    if (!kept || Date.parse(kept.expiresAt) - MARGIN_MS <= now) return null;
    return kept.permission === "write" || wanted === "read" ? kept : null;
  }

  set(repo: string, thread: string, token: KeptToken) {
    this.kept.set(keyOf(repo, thread), token);
  }

  /** Drops the tokens of one repo, or all with null: a reconnect, a key rotation, a lost right, `git credential erase`. */
  drop(repo: string | null) {
    if (repo === null) return this.kept.clear();
    for (const key of this.kept.keys()) if (key.startsWith(keyOf(repo, ""))) this.kept.delete(key);
  }
}
