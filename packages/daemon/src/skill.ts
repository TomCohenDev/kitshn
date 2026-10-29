// K-618: the kitshn skill for coding agents, from the kitshn release that this binary is.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

declare const KITSHN_SKILL: string;

/** The skill of this release, built into the binary; from source, the repo's file. */
export const skillText = () =>
  typeof KITSHN_SKILL === "string"
    ? KITSHN_SKILL
    : readFileSync(new URL("../../kitshn/skill/SKILL.md", import.meta.url), "utf8");

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

/** Where the global copy lives, and the link that agents read it through. */
export const globalSkillPaths = (home: string) => ({
  dir: join(home, ".local", "share", "kitshn", "skills", "kitshn"),
  link: join(home, ".claude", "skills", "kitshn"),
});

/** The end of the text of a link that kitshn made, also on a machine where it does not resolve. */
const OWN_LINK_END = join(".local", "share", "kitshn", "skills", "kitshn");

/**
 * Why kitshn must leave `~/.claude/skills/kitshn` alone, or null when the path is free or kitshn's own link: a link
 * that resolves to kitshn's folder, or whose text ends with that folder. A link or a folder of the user stays.
 */
export function globalLinkRefusal(home: string): string | null {
  const { dir, link } = globalSkillPaths(home);
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (!stat) return null;
  const fix = "Move it away, then run kitshn skill install.";
  if (!stat.isSymbolicLink()) return `kitshn: ${link} is a folder that kitshn did not write. ${fix}`;
  const text = readlinkSync(link);
  if (text.endsWith(OWN_LINK_END)) return null;
  if (existsSync(dir) && existsSync(link) && realpathSync(link) === realpathSync(dir)) return null;
  return `kitshn: ${link} links to ${text}, which is not kitshn's skill, so kitshn leaves it. ${fix}`;
}

/** Writes `text` to `path` through a temporary file, so a reader never sees half a file. */
function writeAtomic(path: string, text: string) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/**
 * Writes the global copy and links `~/.claude/skills/kitshn` to it. The link is relative to the real skills folder,
 * so where dotfiles stow `~/.claude` it is the same link as the one that the dotfiles track. A refusal writes nothing.
 */
export function installGlobalSkill(home: string, version: string, text = skillText()): string {
  const { dir, link } = globalSkillPaths(home);
  const refusal = globalLinkRefusal(home);
  if (refusal) throw new Error(refusal);
  const copy = versionedSkill(text, version, "global");
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "SKILL.md"), copy);
  const skills = join(home, ".claude", "skills");
  mkdirSync(skills, { recursive: true });
  const target = relative(realpathSync(skills), realpathSync(dir));
  if (lstatSync(link, { throwIfNoEntry: false }) === undefined || readlinkSync(link) !== target) {
    // A new link under a temporary name replaces the old one in one step.
    const temporary = `${link}.tmp-${process.pid}`;
    symlinkSync(target, temporary);
    renameSync(temporary, link);
  }
  return `kitshn: the skill of edge-${version} is in ${dir}, and ${link} links to it.`;
}

/** The root of the git repo around `cwd`, or null outside one. */
function repoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

/** Writes the repo copy to `.claude/skills/kitshn/SKILL.md` of the repo around `cwd`. */
export function installRepoSkill(cwd: string, version: string, text = skillText()): string {
  const root = repoRoot(cwd);
  if (root === null) throw new Error(`${cwd} is in no git repo, so kitshn has no place for the repo copy.`);
  const dir = join(root, ".claude", "skills", "kitshn");
  // The kitshn repo links this folder to the skill's source; a copy there would replace the source.
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`${dir} is a link, so kitshn writes no copy there.`);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "SKILL.md"), versionedSkill(text, version, "repo"));
  return `kitshn: the skill of edge-${version} is in ${join(dir, "SKILL.md")}. Commit it with the repo.`;
}

/**
 * Checks the global copy with its link and, inside a repo that has one, the repo copy against this release. A copy
 * of another release counts as out of date.
 */
export function checkSkill(
  home: string,
  cwd: string,
  version: string,
): { ok: boolean; lines: Array<string> } {
  const lines: Array<string> = [];
  const global = join(globalSkillPaths(home).dir, "SKILL.md");
  const root = repoRoot(cwd);
  const copies: Array<[string, string, SkillScope]> = [["global copy", global, "global"]];
  const repoCopy = root === null ? null : join(root, ".claude", "skills", "kitshn", "SKILL.md");
  if (
    repoCopy &&
    existsSync(repoCopy) &&
    !lstatSync(join(root!, ".claude", "skills", "kitshn")).isSymbolicLink()
  )
    copies.push(["repo copy", repoCopy, "repo"]);
  let ok = true;
  const { dir, link } = globalSkillPaths(home);
  const refusal = globalLinkRefusal(home);
  if (refusal || !existsSync(link) || !existsSync(dir) || realpathSync(link) !== realpathSync(dir)) {
    ok = false;
    lines.push(
      refusal ?? `kitshn: ${link} does not link to the global copy. Fix it with: ${SKILL_UPDATE.global}`,
    );
  }
  for (const [name, path, scope] of copies) {
    if (!existsSync(path)) {
      ok = false;
      lines.push(`kitshn: no ${name} of the skill. Install it with: ${SKILL_UPDATE[scope]}`);
      continue;
    }
    const named = skillVersion(readFileSync(path, "utf8"));
    if (named === version) lines.push(`kitshn: the ${name} is edge-${version}.`);
    else {
      ok = false;
      lines.push(
        `kitshn: the ${name} (${path}) is edge-${named ?? "unknown"}, not edge-${version} (this kitshn). Update it with: ${SKILL_UPDATE[scope]}`,
      );
    }
  }
  return { ok, lines };
}

/**
 * The daemon writes the global copy again at its start when the copy names another release, as after an update. A
 * link of the user stops it with one line, which the daemon logs once per release.
 */
export function refreshGlobalSkill(home: string, version: string): string | null {
  const { dir } = globalSkillPaths(home);
  const file = join(dir, "SKILL.md");
  if (!existsSync(file) || skillVersion(readFileSync(file, "utf8")) === version) return null;
  const refusal = globalLinkRefusal(home);
  if (!refusal) return installGlobalSkill(home, version);
  const said = join(dir, "refused");
  if (existsSync(said) && readFileSync(said, "utf8") === version) return null;
  writeAtomic(said, version);
  return refusal;
}
