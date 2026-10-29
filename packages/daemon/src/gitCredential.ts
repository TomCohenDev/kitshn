// K-1763, K-1764: the git credential helper protocol and the repo of a gh call. Pure, for tests.
import type { Answer } from "@kitshn/local";

/** The `key=value` lines that git sends to a credential helper, up to the first empty line. */
export function readCredentialInput(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") break;
    const equals = line.indexOf("=");
    if (equals > 0) fields[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return fields;
}

/** K-1763: the `owner/name` of a GitHub repo from the helper input, or null for another host or no path. */
export function repoOfCredential(fields: Readonly<Record<string, string>>): string | null {
  if (fields["protocol"] !== "https" || fields["host"] !== "github.com") return null;
  return repoOfPath(fields["path"] ?? "");
}

/** `owner/name` from a GitHub path such as `owner/name.git`, or null. */
function repoOfPath(path: string): string | null {
  const trimmed = path.endsWith(".git") ? path.slice(0, -".git".length) : path;
  const parts = trimmed.split("/").filter((part) => part !== "");
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
}

/** K-1764: `owner/name` of a git remote URL on github.com (https or ssh), or null. */
export function repoOfRemote(url: string): string | null {
  const text = url.trim();
  for (const prefix of ["https://github.com/", "git@github.com:", "ssh://git@github.com/"])
    if (text.startsWith(prefix)) return repoOfPath(text.slice(prefix.length));
  return null;
}

/** K-1763: the answer of the helper for a token, with its expiry, so a helper that stores it drops it in time. */
export const credentialAnswer = (token: string, expiresAt: string) =>
  `username=x-access-token\npassword=${token}\npassword_expiry_utc=${Math.floor(Date.parse(expiresAt) / 1000)}\n`;

/**
 * K-1763, K-1752: what `kitshn git-credential get` prints for kitshn's answer. A token answers git. A refusal or a
 * waiting ask of a kitshn owner, also a thread that the attester could not check, prints `quit=1`, so git never falls
 * back to the machine's own login. A daemon that cannot help (no daemon, no connection, another owner) prints nothing,
 * so git tries its next helper.
 */
export function credentialReply(answer: Answer | null): {
  readonly stdout: string;
  readonly stderr: string | null;
} {
  if (answer === null || answer.type !== "ask" || answer.outcome === "not-kitshn")
    return { stdout: "", stderr: null };
  if (answer.outcome === "done" && typeof answer.result === "object" && answer.result !== null) {
    const { token, expiresAt } = answer.result as { token?: unknown; expiresAt?: unknown };
    if (typeof token === "string" && typeof expiresAt === "string")
      return { stdout: credentialAnswer(token, expiresAt), stderr: null };
  }
  const why =
    answer.outcome === "refused"
      ? answer.reason
      : answer.outcome === "waiting"
        ? `the token waits for an approval (proposal ${answer.proposalId}); push again after it`
        : "kitshn gave no token";
  return { stdout: "quit=1\n", stderr: `kitshn: ${why}` };
}
