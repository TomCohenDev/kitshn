// K-1733, K-1760: repo groups and the GitHub way of an owner. Pure, for tests.
import { type GitHubWay, type Resource, type State } from "./model.ts";

const NAME_CHARS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.");

/** K-1733: why a match is not an owner or an owner and a name pattern with at most one `*`, or null. */
export function matchProblem(match: string): string | null {
  const parts = match.split("/");
  if (parts.length > 2) return "A repo group matches an owner, or owner/pattern with one *.";
  const [owner = "", name] = parts;
  if (owner === "" || ![...owner].every((char) => NAME_CHARS.has(char)))
    return "The owner has letters, digits, dashes, dots and underscores only.";
  if (name === undefined) return null;
  if (name === "" || ![...name].every((char) => char === "*" || NAME_CHARS.has(char)))
    return "The name pattern has letters, digits, dashes, dots, underscores and one *.";
  if (name.split("*").length > 2) return "A name pattern has at most one *.";
  return null;
}

/** K-1733: true when a full repo name (`owner/name`) falls in the match; GitHub names ignore case. */
export function repoGroupMatches(match: string, fullName: string): boolean {
  const [owner, name] = fullName.toLowerCase().split("/");
  const [matchOwner, pattern] = match.toLowerCase().split("/");
  if (!owner || !name || owner !== matchOwner) return false;
  if (pattern === undefined) return true;
  const star = pattern.indexOf("*");
  if (star < 0) return name === pattern;
  const before = pattern.slice(0, star);
  const after = pattern.slice(star + 1);
  return name.length >= before.length + after.length && name.startsWith(before) && name.endsWith(after);
}

/** K-1733: the cards that cover one repo: its repo groups and a repo card of that name. */
export const coveringCards = (state: State, fullName: string): Array<Resource> =>
  [...state.resources.values()].filter(
    (resource) =>
      (resource.kind === "repo.group" &&
        resource.match !== undefined &&
        repoGroupMatches(resource.match, fullName)) ||
      (resource.kind === "repo" && resource.name.toLowerCase() === fullName.toLowerCase()),
  );

/** K-1760: the GitHub way of an owner: its owner group's, else the default of Settings. */
export function githubWayOf(state: State, owner: string, fallback: GitHubWay): GitHubWay {
  const group = [...state.resources.values()].find(
    (resource) =>
      resource.kind === "repo.group" &&
      resource.match !== undefined &&
      !resource.match.includes("/") &&
      resource.match.toLowerCase() === owner.toLowerCase(),
  );
  return group?.githubWay ?? fallback;
}

/**
 * K-1733: the card id of a repo group, from its match: ids allow only a-z, 0-9 and dashes, at most 63 characters, so
 * "/" becomes "--", "*" becomes "x" and every other character a dash. Null when the id would be too long.
 */
export function repoGroupId(match: string): string | null {
  const id = `repo-group-${[...match.toLowerCase()]
    .map((char) =>
      char === "/"
        ? "--"
        : char === "*"
          ? "x"
          : "abcdefghijklmnopqrstuvwxyz0123456789-".includes(char)
            ? char
            : "-",
    )
    .join("")}`;
  return id.length <= 63 ? id : null;
}
