// K-1763, K-1764: the git credential helper protocol and the repo of a gh call. Pure, for tests.

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
