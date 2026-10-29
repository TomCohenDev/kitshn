import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skillVersion } from "kitshn/skill";
import { checkSkill, installGlobalSkill, installRepoSkill, refreshGlobalSkill } from "./skill.ts";

const SKILL = "---\nname: kitshn\ndescription: Deploy with kitshn.\n---\n\n# kitshn\n";
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

/** A home whose `~/.claude` is stowed from a dotfiles checkout, as on the owner's machines. */
function stowedHome() {
  const home = mkdtempSync(join(tmpdir(), "kitshn-skill-"));
  mkdirSync(join(home, "Github", "dotfiles", "main", ".claude", "skills"), { recursive: true });
  symlinkSync("Github/dotfiles/main/.claude", join(home, ".claude"));
  return home;
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kitshn-skill-repo-"));
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return dir;
}

describe("kitshn skill (K-618)", () => {
  it("installs the global copy behind the same link that the dotfiles track", () => {
    const home = stowedHome();
    installGlobalSkill(home, A, SKILL);
    // The tracked dotfiles link: ~/Github/dotfiles/main/.claude/skills/kitshn -> ../../../../../.local/share/...
    expect(readlinkSync(join(home, "Github", "dotfiles", "main", ".claude", "skills", "kitshn"))).toBe(
      "../../../../../.local/share/kitshn/skills/kitshn",
    );
    const copy = readFileSync(join(home, ".claude", "skills", "kitshn", "SKILL.md"), "utf8");
    // The front matter stays first, and the next line names the release and the update.
    expect(copy.startsWith("---\nname: kitshn\n")).toBe(true);
    expect(copy).toContain(`---\n<!-- kitshn edge-${A}. Update it with: kitshn skill install -->\n`);
    expect(skillVersion(copy)).toBe(A);
    // A second run keeps the link, and a folder that kitshn did not write stops it.
    installGlobalSkill(home, B, SKILL);
    expect(lstatSync(join(home, ".claude", "skills", "kitshn")).isSymbolicLink()).toBe(true);
    // kitshn's own link stays kitshn's, also when it does not resolve on this machine.
    const moved = stowedHome();
    symlinkSync("/elsewhere/.local/share/kitshn/skills/kitshn", join(moved, ".claude", "skills", "kitshn"));
    installGlobalSkill(moved, A, SKILL);
    expect(readlinkSync(join(moved, ".claude", "skills", "kitshn"))).toBe(
      "../../../../../.local/share/kitshn/skills/kitshn",
    );
  });

  it("leaves a folder or a link of the user alone and writes nothing, also at the daemon start", () => {
    const mine = (setup: (link: string, home: string) => void) => {
      const home = stowedHome();
      setup(join(home, ".claude", "skills", "kitshn"), home);
      return home;
    };
    const homes = {
      folder: mine((link) => mkdirSync(link)),
      link: mine((link, home) => {
        mkdirSync(join(home, "mine"));
        symlinkSync(join(home, "mine"), link);
      }),
      broken: mine((link) => symlinkSync("../../mine-gone", link)),
    };
    for (const [name, home] of Object.entries(homes)) {
      expect(() => installGlobalSkill(home, A, SKILL), name).toThrow(
        name === "folder" ? "folder" : "links to",
      );
      expect(existsSync(join(home, ".local", "share", "kitshn")), name).toBe(false);
      expect(checkSkill(home, tmpdir(), A).ok, name).toBe(false);
    }
    expect(readlinkSync(join(homes.broken, ".claude", "skills", "kitshn"))).toBe("../../mine-gone");

    // An old copy behind a link that the user changed later: the daemon says so once per release, and changes nothing.
    const home = stowedHome();
    installGlobalSkill(home, A, SKILL);
    const link = join(home, ".claude", "skills", "kitshn");
    unlinkSync(link);
    symlinkSync("../../mine-gone", link);
    expect(refreshGlobalSkill(home, B)).toContain("links to ../../mine-gone");
    expect(refreshGlobalSkill(home, B)).toBeNull();
    expect(readlinkSync(link)).toBe("../../mine-gone");
  });

  it("writes the repo copy, refuses a linked skill folder, and checks both copies against the release", () => {
    const home = stowedHome();
    const dir = repo();
    expect(() => installRepoSkill(tmpdir(), A, SKILL)).toThrow("no git repo");
    installRepoSkill(dir, A, SKILL);
    const copy = readFileSync(join(dir, ".claude", "skills", "kitshn", "SKILL.md"), "utf8");
    expect(copy).toContain(`<!-- kitshn edge-${A}. Update it with: kitshn skill install --repo -->`);

    expect(checkSkill(home, dir, A)).toMatchObject({ ok: false });
    installGlobalSkill(home, A, SKILL);
    expect(checkSkill(home, dir, A).ok).toBe(true);
    const old = checkSkill(home, dir, B);
    expect(old.ok).toBe(false);
    expect(old.lines.join("\n")).toContain("Update it with: kitshn skill install --repo");

    // The daemon start writes an old global copy again, and leaves a current one alone.
    expect(refreshGlobalSkill(home, A)).toBeNull();
    expect(refreshGlobalSkill(home, B)).not.toBeNull();
    expect(checkSkill(home, tmpdir(), B).ok).toBe(true);

    const linked = repo();
    mkdirSync(join(linked, "skill"));
    mkdirSync(join(linked, ".claude", "skills"), { recursive: true });
    symlinkSync("../../skill", join(linked, ".claude", "skills", "kitshn"));
    writeFileSync(join(linked, "skill", "SKILL.md"), SKILL);
    expect(() => installRepoSkill(linked, A, SKILL)).toThrow("is a link");
  });
});
