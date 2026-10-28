// K-1753: only an attester sets the labels of its prefix, so the daemon drops a caller's labels with such a prefix.

/** K-1755: `t3.` is the prefix of the T3 attester; it stays reserved also before a machine lists that attester. */
export const RESERVED_PREFIXES: ReadonlyArray<string> = ["t3."];

/** K-1751: the label prefixes of the attesters in `machine.json`, and the reserved ones. */
export function attesterPrefixes(machine: unknown): ReadonlyArray<string> {
  const listed =
    typeof machine === "object" &&
    machine !== null &&
    "attesters" in machine &&
    Array.isArray(machine.attesters)
      ? machine.attesters.flatMap((attester: unknown) =>
          typeof attester === "object" &&
          attester !== null &&
          "prefix" in attester &&
          typeof attester.prefix === "string"
            ? [attester.prefix]
            : [],
        )
      : [];
  return [...new Set([...RESERVED_PREFIXES, ...listed])];
}

/** K-1753: the caller's labels without the ones that an attester sets. */
export const dropAttested = (
  labels: Readonly<Record<string, string>>,
  prefixes: ReadonlyArray<string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels).filter(([key]) => !prefixes.some((prefix) => key.startsWith(prefix))),
  );
