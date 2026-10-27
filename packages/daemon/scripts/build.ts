// Builds one kitshn binary per platform with Bun (K-601), for the edge release and the join script.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const version = process.env["GITHUB_SHA"]?.slice(0, 12) ?? "dev";
const targets = [
  ["bun-linux-arm64", "kitshn-linux-arm64"],
  ["bun-linux-x64", "kitshn-linux-x64"],
  ["bun-darwin-arm64", "kitshn-darwin-arm64"],
  ["bun-darwin-x64", "kitshn-darwin-x64"],
] as const;
const only = process.argv[2];
mkdirSync(new URL("../dist", import.meta.url), { recursive: true });
for (const [target, name] of targets) {
  if (only && !name.endsWith(only)) continue;
  execFileSync(
    "bun",
    [
      "build",
      "src/main.ts",
      "--compile",
      `--target=${target}`,
      `--define=KITSHN_VERSION="${version}"`,
      `--outfile=dist/${name}`,
    ],
    { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname },
  );
}
