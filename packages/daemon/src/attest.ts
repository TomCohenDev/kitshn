// K-1751 to K-1755: attesters vouch for the thread that asks. Only an attester sets the labels of its prefix.

/** K-1755: `t3.` is the prefix of the T3 attester; it stays reserved also before a machine lists that attester. */
export const RESERVED_PREFIXES: ReadonlyArray<string> = ["t3."];

/** K-1751: one attester of `machine.json`: its label prefix, its loopback address and the variable of the token. */
export interface Attester {
  readonly prefix: string;
  readonly address: string;
  readonly tokenEnv: string;
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

/**
 * K-1751: the attesters of `machine.json`, and why each other entry is refused: an address off loopback, a prefix
 * without a dot, or a missing variable name. Only the daemon user and root write an attester (`attester-set`).
 */
export function attestersOf(machine: unknown): {
  readonly attesters: Array<Attester>;
  readonly refused: Array<string>;
} {
  const list =
    typeof machine === "object" &&
    machine !== null &&
    "attesters" in machine &&
    Array.isArray(machine.attesters)
      ? (machine.attesters as Array<unknown>)
      : [];
  const attesters: Array<Attester> = [];
  const refused: Array<string> = [];
  for (const entry of list) {
    const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const prefix = typeof item["prefix"] === "string" ? item["prefix"] : "";
    const address = typeof item["address"] === "string" ? item["address"] : "";
    const tokenEnv = typeof item["tokenEnv"] === "string" ? item["tokenEnv"] : "";
    let host = "";
    try {
      host = new URL(address).hostname;
    } catch {
      host = "";
    }
    if (!prefix.endsWith(".") || prefix.length < 2)
      refused.push(`${prefix || "(none)"}: a prefix ends with a dot`);
    else if (!LOOPBACK.has(host)) refused.push(`${prefix}: ${address} is not on loopback`);
    else if (tokenEnv === "") refused.push(`${prefix}: no tokenEnv`);
    else attesters.push({ prefix, address, tokenEnv });
  }
  return { attesters, refused };
}

/** K-1751: the label prefixes of the attesters, and the reserved ones. */
export const attesterPrefixes = (attesters: ReadonlyArray<Attester>): ReadonlyArray<string> => [
  ...new Set([...RESERVED_PREFIXES, ...attesters.map((attester) => attester.prefix)]),
];

/** K-1753: the caller's labels without the ones that an attester sets. */
export const dropAttested = (
  labels: Readonly<Record<string, string>>,
  prefixes: ReadonlyArray<string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels).filter(([key]) => !prefixes.some((prefix) => key.startsWith(prefix))),
  );

/** K-1755: the fields of the T3 route and their labels. */
const T3_LABELS: Readonly<Record<string, string>> = {
  threadId: "thread.id",
  threadTitle: "thread.title",
  projectId: "project.id",
  projectName: "project.name",
  environmentId: "environment.id",
  providerInstanceId: "provider",
  runtimeMode: "runtime",
  interactionMode: "interaction",
  subagent: "subagent",
  parentThreadId: "thread.parent",
  parentEnvironmentId: "thread.parent.environment",
};

/**
 * K-1752, K-1755: the labels of an active answer. The T3 attester has its fixed names; another attester gives each
 * text or yes/no field under its own name, lower case. Values longer than 256 characters are cut (K-1750).
 */
export function attestedLabels(prefix: string, answer: unknown): Record<string, string> | null {
  if (typeof answer !== "object" || answer === null) return null;
  const fields = answer as Record<string, unknown>;
  if (fields["active"] !== true) return null;
  const labels: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (field === "active" || field === "checkedAt") continue;
    const name = prefix === "t3." ? T3_LABELS[field] : field.toLowerCase();
    if (name === undefined) continue;
    const text =
      value === null ? "" : typeof value === "string" || typeof value === "boolean" ? String(value) : null;
    if (text !== null) labels[`${prefix}${name}`] = text.slice(0, 256);
  }
  return labels;
}

/** K-1752: what one attester said about the caller's token. */
export type Attestation =
  | { readonly outcome: "labels"; readonly labels: Record<string, string> }
  | { readonly outcome: "inactive" }
  | { readonly outcome: "failed" };

/** K-1752: asks one attester with the caller's token, at most 2 seconds. */
export async function attest(attester: Attester, token: string): Promise<Attestation> {
  try {
    const response = await fetch(attester.address, {
      headers: { authorization: token },
      // A redirect could carry the caller's token to another address.
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return { outcome: "failed" };
    const answer: unknown = await response.json();
    if (
      typeof answer === "object" &&
      answer !== null &&
      (answer as Record<string, unknown>)["active"] === false
    )
      return { outcome: "inactive" };
    const labels = attestedLabels(attester.prefix, answer);
    return labels === null ? { outcome: "failed" } : { outcome: "labels", labels };
  } catch {
    return { outcome: "failed" };
  }
}

/**
 * K-1752: the refusal of a call whose token an attester could not vouch for; a call never falls back to the bare
 * machine once it carries a token.
 */
export function attestationRefusal(attester: Attester, result: Attestation): string | null {
  const name = attester.prefix === "t3." ? "T3" : attester.prefix.slice(0, -1);
  if (result.outcome === "failed") return `could not check the ${name} thread; try again.`;
  if (result.outcome === "inactive")
    return `the ${name} thread of this call is not active (archived or deleted).`;
  return null;
}

/**
 * K-1751: `machine.json` with this attester, which replaces an older entry of the same prefix; or why it is refused,
 * by the rules of `attestersOf`.
 */
export function withAttester(
  machine: Record<string, unknown>,
  entry: Attester,
): Record<string, unknown> | string {
  const { refused } = attestersOf({ attesters: [entry] });
  if (refused[0]) return refused[0];
  const old = Array.isArray(machine["attesters"]) ? (machine["attesters"] as Array<unknown>) : [];
  const others = old.filter(
    (item) =>
      !(
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>)["prefix"] === entry.prefix
      ),
  );
  return { ...machine, attesters: [...others, { ...entry }] };
}
