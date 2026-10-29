import { describe, expect, it } from "vitest";
import { skillText, skillVersion, versionedSkill } from "./skill.ts";

describe("kitshn skill text (K-618)", () => {
  it("keeps the front matter first and names the release and the update on the next line", () => {
    const copy = versionedSkill(skillText(), "abcdef123456", "repo");
    expect(copy.startsWith("---\nname: kitshn\n")).toBe(true);
    expect(copy).toContain(
      "\n---\n<!-- kitshn edge-abcdef123456. Update it with: kitshn skill install --repo -->\n",
    );
    expect(skillVersion(copy)).toBe("abcdef123456");
    expect(skillVersion(skillText())).toBeNull();
    expect(() => versionedSkill("# no front matter\n", "x", "repo")).toThrow("front matter");
  });
});
