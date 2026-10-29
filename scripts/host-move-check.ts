// K-1209: proves that no link to the old admin host remains, so the move can end with no redirect.
//   node scripts/host-move-check.ts kit.yarden-zamir.com Yarden-zamir [more owners]
// It searches the default branch of every repo of each owner with GitHub code search, and every file of this
// checkout with git grep. It prints each hit and exits 1 while one remains. Known limit: GitHub code search covers
// only default branches; an open branch that names the old host shows up when it merges. Revisit if branches matter.
import { execFileSync, spawnSync } from "node:child_process";

const [host, ...owners] = process.argv.slice(2);
if (!host || owners.length === 0) {
  console.error("usage: node scripts/host-move-check.ts <old host> <owner> [owner...]");
  process.exit(2);
}
const hits: Array<string> = [];
for (const owner of owners) {
  const found = JSON.parse(
    execFileSync(
      "gh",
      ["search", "code", host, "--owner", owner, "--limit", "200", "--json", "repository,path"],
      { encoding: "utf8" },
    ),
  ) as Array<{ repository: { nameWithOwner: string }; path: string }>;
  for (const item of found) hits.push(`${item.repository.nameWithOwner}: ${item.path}`);
}
const local = spawnSync("git", ["grep", "-l", "-F", host], { encoding: "utf8" });
for (const path of local.stdout.split("\n").filter(Boolean)) hits.push(`this checkout: ${path}`);
for (const hit of hits) console.log(hit);
console.log(hits.length === 0 ? `No link to ${host} remains.` : `${hits.length} files still name ${host}.`);
process.exit(hits.length === 0 ? 0 : 1);
