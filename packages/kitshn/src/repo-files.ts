import { deployWorkflow } from "./templates.ts";

/** K-1127: what kitshn answers to a handover: the card and the addresses that its repo serves, the main one first. */
export interface HandoverAnswer {
  readonly card: string;
  readonly kind: "page" | "folder";
  readonly addresses: ReadonlyArray<string>;
}

/**
 * K-1127: the files that `kitshn repo` writes next to `site/`: a static recipe with the card's addresses, the deploy
 * workflow of "Add a site", a README with the deploy badge of K-1119, and the repo copy of the kitshn skill (K-618).
 */
export function repoFiles(
  handover: HandoverAnswer,
  repo: string,
  server: string,
  skill: string,
): Record<string, string> {
  const [owner = "", name = ""] = repo.split("/");
  const address =
    handover.addresses.length === 1
      ? JSON.stringify(handover.addresses[0])
      : JSON.stringify(handover.addresses);
  return {
    "kitshn.config.ts": `import { defineApp } from "kitshn";

export default defineApp({
  static: { output: "site" },
  deploy: [{ on: "push", branch: "main", name: "prod", address: ${address} }],
});
`,
    "README.md": `# ${name}\n\n![kitshn](${new URL(`/public/badges/${owner}/${name}.svg`, server).toString()})\n\nDeployed with kitshn at https://${handover.addresses[0] ?? ""}.\n`,
    ".github/workflows/kitshn.yml": `${deployWorkflow(new URL(server).origin)}\n`,
    ".claude/skills/kitshn/SKILL.md": skill,
  };
}
