/** The fingerprints of the key files of a machine; null for a missing file. */
export interface KeyFiles {
  /** `machine.key`. */
  readonly current: string | null;
  /** `machine.key.next`: a rotation that kitshn may have stored (K-1705). */
  readonly next: string | null;
  /** `machine.key.rekey`: a key from a join or rekey code that kitshn may have stored (K-1703, K-1706). */
  readonly fromCode: string | null;
}

export interface KeyPlan {
  /** The pending file that becomes `machine.key` before the daemon signs. */
  readonly promote: "next" | "fromCode" | null;
  /** Remove `machine.key.next`: kitshn never took that rotation. A key from a code is never removed here. */
  readonly dropNext: boolean;
}

/** K-1704: which pending key file the key that a challenge names is. `expected` is null without a key (K-1708). */
export function keyPlan(expected: string | null, files: KeyFiles): KeyPlan {
  const promote =
    expected !== null && files.fromCode === expected
      ? "fromCode"
      : expected !== null && files.next === expected
        ? "next"
        : null;
  return { promote, dropNext: files.next !== null && promote !== "next" };
}
