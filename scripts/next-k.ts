// Spec numbers across open pull requests, so two PRs never take the same K- number.
//   node scripts/next-k.ts <block>   prints the next free number of a block: 11 gives a number from K-1101 to K-1199.
//   node scripts/next-k.ts --check   fails when this checkout's SPEC.md adds a number that origin/main or another open PR
//                                    defines with other text, or uses one number twice. PR_NUMBER skips this PR's head.
// It reads origin/main with git and the open PRs with gh, so it needs a fetched origin and a gh login (GH_TOKEN in CI).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MARK = "- **K-";

const run = (command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Each `- **K-<n>** <text>` line of a spec, in order. */
function lines(spec: string): Array<{ readonly number: number; readonly text: string }> {
  return spec.split("\n").flatMap((line) => {
    const rest = line.trimStart();
    if (!rest.startsWith(MARK)) return [];
    const end = rest.indexOf("**", MARK.length);
    const number = Number(rest.slice(MARK.length, end));
    if (end < 0 || !Number.isInteger(number))
      throw new Error(`SPEC.md has a K- line that does not parse: ${line}`);
    return [{ number, text: rest.slice(end + 2).trim() }];
  });
}

const definitions = (spec: string): ReadonlyMap<number, string> =>
  new Map(lines(spec).map((line) => [line.number, line.text]));

interface Source {
  readonly name: string;
  readonly definitions: ReadonlyMap<number, string>;
}

/** origin/main first, then the head of every open PR except `skipPr`. */
function sources(skipPr: string | undefined): Array<Source> {
  const main = { name: "origin/main", definitions: definitions(run("git", ["show", "origin/main:SPEC.md"])) };
  const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  const prs = JSON.parse(
    run("gh", ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefOid"]),
  ) as Array<{ readonly number: number; readonly headRefOid: string }>;
  const open = prs
    .filter((pr) => String(pr.number) !== skipPr)
    .flatMap((pr) => {
      let spec: string;
      try {
        spec = run("gh", [
          "api",
          "-H",
          "Accept: application/vnd.github.raw",
          `repos/${repo}/contents/SPEC.md?ref=${pr.headRefOid}`,
        ]);
      } catch {
        // A head without SPEC.md, or of a deleted fork, defines nothing.
        return [];
      }
      return [{ name: `#${pr.number}`, definitions: definitions(spec) }];
    });
  return [main, ...open];
}

function nextFree(block: number, all: ReadonlyArray<Source>) {
  const low = block * 100;
  const used = all
    .flatMap((source) => [...source.definitions.keys()])
    .filter((n) => n > low && n < low + 100);
  const next = used.length === 0 ? low + 1 : Math.max(...used) + 1;
  if (next >= low + 100) throw new Error(`Block ${block} is full.`);
  return next;
}

function clashes(all: ReadonlyArray<Source>): Array<string> {
  const spec = readFileSync("SPEC.md", "utf8");
  const mine = lines(spec);
  const seen = new Set<number>();
  const twice = mine.flatMap((line) => {
    if (!seen.has(line.number)) return (seen.add(line.number), []);
    return [`K-${line.number} appears twice in this SPEC.md.`];
  });
  // New means: not in the spec where this branch left main. An edit of an older requirement is no clash.
  const base = definitions(
    run("git", ["show", `${run("git", ["merge-base", "HEAD", "origin/main"]).trim()}:SPEC.md`]),
  );
  const taken = [...definitions(spec)]
    .filter(([number]) => !base.has(number))
    .flatMap(([number, text]) =>
      all
        .filter((source) => source.definitions.has(number) && source.definitions.get(number) !== text)
        .map((source) => `K-${number} is new here, and ${source.name} defines it with other text.`),
    );
  return [...twice, ...taken];
}

const [argument] = process.argv.slice(2);
const block = Number(argument);
if (argument === "--check") {
  const found = clashes(sources(process.env["PR_NUMBER"]));
  for (const clash of found) console.error(clash);
  if (found.length > 0) {
    console.error("Pick a free number with: node scripts/next-k.ts <block>");
    process.exit(1);
  }
  console.log("No K- number of this SPEC.md clashes with origin/main or another open PR.");
} else if (Number.isInteger(block) && block >= 1 && block <= 99) {
  console.log(`K-${nextFree(block, sources(undefined))}`);
} else {
  console.error("Usage: node scripts/next-k.ts <block> | --check");
  process.exit(2);
}
