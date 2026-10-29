// K-618: the kitshn skill for coding agents, as text. The daemon and the App CLI carry the skill of their release.
import { readFileSync } from "node:fs";

declare const KITSHN_SKILL: string;
declare const KITSHN_VERSION: string;

/** The release that this build is, `dev` from source. */
export const KITSHN_RELEASE = typeof KITSHN_VERSION === "string" ? KITSHN_VERSION : "dev";

/** The skill of this release, built in; from source, the repo's file. */
export const skillText = () =>
  typeof KITSHN_SKILL === "string"
    ? KITSHN_SKILL
    : readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");

export const SKILL_UPDATE = { global: "kitshn skill install", repo: "kitshn skill install --repo" } as const;
export type SkillScope = keyof typeof SKILL_UPDATE;

const MARK = "<!-- kitshn edge-";

/**
 * The skill with one line after its front matter that names the release and the update command. The front matter
 * stays first, because agents read the skill's name and description from it.
 */
export function versionedSkill(text: string, version: string, scope: SkillScope) {
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
  if (end < 0) throw new Error("The kitshn skill has no front matter.");
  const cut = end + "\n---\n".length;
  return `${text.slice(0, cut)}${MARK}${version}. Update it with: ${SKILL_UPDATE[scope]} -->\n${text.slice(cut)}`;
}

/** The release that a copy of the skill names, or null for a copy without the line. */
export function skillVersion(text: string): string | null {
  const at = text.indexOf(MARK);
  if (at < 0) return null;
  const rest = text.slice(at + MARK.length);
  const version = rest.slice(0, rest.indexOf("."));
  return version === "" ? null : version;
}
