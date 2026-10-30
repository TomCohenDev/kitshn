/**
 * K-704: why kitshn refused a provider, in words, with the next step. A schema error of the provider state names the
 * value and its limit; the raw reason stays behind "Details".
 */
export function refusalText(provider: string, machine: string, reason: string): string {
  if (!reason.includes("Expected ")) return reason;
  const rowId = reason.includes('["rows"]') && reason.endsWith('["id"]');
  const limit = reason.split("length of at most ")[1]?.split(" ")[0];
  // The same words cover a string and a list, so only the row id, a known string, may say "characters".
  const problem =
    limit === undefined
      ? "a value that kitshn does not accept"
      : rowId
        ? `a list row id over ${limit} characters`
        : `a value over the limit of ${limit}`;
  return `${provider} on ${machine} sent ${problem}. Update ${provider} on ${machine}.`;
}
