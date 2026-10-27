// The kitshn CLI for app repos: `kitshn check` (K-802) and `kitshn deploy` (K-803, K-805, K-811).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { RecipeError, readRecipe } from "./parse.ts";
import { type DeployEvent, decodeRecipe } from "./recipe.ts";

const fail = (text: string): never => {
  console.error(`kitshn: ${text}`);
  process.exit(1);
};

function loadRecipe(dir: string) {
  const file = join(dir, "kitshn.config.ts");
  if (!existsSync(file)) fail(`${file} does not exist.`);
  try {
    return decodeRecipe(readRecipe(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof RecipeError) fail(error.message);
    return fail(`kitshn.config.ts does not match the recipe schema: ${String(error)}`);
  }
}

/** The GitHub Actions OIDC token for the kitshn server (K-811). It needs `permissions: id-token: write`. */
async function oidcToken(audience: string): Promise<string> {
  const url = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const token = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!url || !token) fail("no GitHub OIDC token. The workflow needs `permissions: id-token: write`.");
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${token}` },
  });
  const body = (await response.json()) as { value?: string };
  if (!body.value) fail(`GitHub gave no OIDC token (${response.status}).`);
  return body.value as string;
}

function githubEvent(): DeployEvent {
  const name = process.env["GITHUB_EVENT_NAME"];
  const payload = JSON.parse(readFileSync(process.env["GITHUB_EVENT_PATH"] ?? "", "utf8")) as {
    action?: string;
    pull_request?: { number: number; head: { ref: string } };
  };
  if (name === "pull_request") {
    const pr = payload.pull_request;
    return { name, branch: pr?.head.ref ?? "", pr: pr?.number ?? null, action: payload.action ?? null };
  }
  if (name === "push") return { name, branch: process.env["GITHUB_REF_NAME"] ?? "", pr: null, action: null };
  return fail(`kitshn deploys on push and pull_request, not on ${name}.`);
}

async function call<T>(server: string, path: string, body: object): Promise<T> {
  const response = await fetch(new URL(path, server), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await oidcToken(new URL(server).origin)}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !data) fail(data?.error ?? `${path} answered ${response.status}.`);
  return data as T;
}

/**
 * The files of a static site. It skips dotfiles and dot folders (.git holds the checkout token) and does
 * not follow symlinks, so nothing outside the output folder is published.
 */
const files = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    if (name.startsWith(".")) return [];
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [];
    return stat.isDirectory() ? files(path) : [path];
  });

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

/** K-805: uploads the built files through the Workers direct upload flow; kitshn deploys them. */
async function deploy(server: string, dir: string) {
  const recipe = loadRecipe(dir);
  const event = githubEvent();
  const plan = await call<{
    deployId: string | null;
    plan: { kind: string; reason?: string; address?: string; environment?: string };
  }>(server, "/deploy/plan", { recipe, event });
  if (plan.plan.kind === "skip" || !plan.deployId) {
    console.log(`kitshn: nothing to do. ${plan.plan.reason ?? ""}`);
    return;
  }
  if (plan.plan.kind === "teardown") {
    await call(server, "/deploy/teardown", { deployId: plan.deployId });
    console.log(`kitshn: removed ${plan.plan.environment} at https://${plan.plan.address}`);
    return;
  }
  if (recipe.static.build) {
    console.log(`kitshn: building with: ${recipe.static.build}`);
    execFileSync("sh", ["-c", recipe.static.build], { cwd: dir, stdio: "inherit" });
  }
  const output = resolve(dir, recipe.static.output);
  // realpath follows a symlinked output folder, so a link cannot point outside the repo.
  const real = existsSync(output) ? realpathSync(output) : output;
  const root = realpathSync(dir);
  if (real !== root && !real.startsWith(root + sep)) {
    fail(`the output folder ${recipe.static.output} is outside the repo.`);
  }
  if (!existsSync(output)) fail(`the output folder ${recipe.static.output} does not exist after the build.`);
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, { path: string; type: string }>();
  for (const path of files(output)) {
    const bytes = readFileSync(path);
    const extension = extname(path).toLowerCase();
    const hash = createHash("sha256")
      .update(bytes.toString("base64") + extension.slice(1))
      .digest("hex")
      .slice(0, 32);
    manifest[`/${relative(output, path).split("\\").join("/")}`] = { hash, size: bytes.length };
    byHash.set(hash, { path, type: TYPES[extension] ?? "application/octet-stream" });
  }
  if (Object.keys(manifest).length === 0) fail(`the output folder ${recipe.static.output} is empty.`);
  const session = await call<{ jwt: string; buckets: Array<Array<string>>; uploadUrl: string }>(
    server,
    "/deploy/assets",
    {
      deployId: plan.deployId,
      manifest,
    },
  );
  let completion = session.jwt;
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      if (!file) fail(`Cloudflare asked for an unknown file ${hash}.`);
      form.append(hash, new Blob([readFileSync(file!.path).toString("base64")], { type: file!.type }), hash);
    }
    const response = await fetch(session.uploadUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${session.jwt}` },
      body: form,
    });
    const body = (await response.json()) as { success: boolean; result?: { jwt?: string }; errors?: unknown };
    if (!body.success) fail(`the file upload failed: ${JSON.stringify(body.errors)}`);
    if (body.result?.jwt) completion = body.result.jwt;
  }
  const done = await call<{ address: string; status: number; card: string }>(server, "/deploy/finish", {
    deployId: plan.deployId,
    jwt: completion,
  });
  console.log(
    `kitshn: deployed ${Object.keys(manifest).length} files to https://${done.address} (route check: ${done.status}).`,
  );
  console.log(`kitshn: ${done.card}`);
}

const [command, ...args] = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

if (command === "check") {
  console.log(JSON.stringify(loadRecipe(flag("--dir", ".")), null, 2));
} else if (command === "deploy") {
  await deploy(flag("--server", ""), flag("--dir", "."));
} else {
  console.log(`kitshn check [--dir <app>]                  check kitshn.config.ts and print it as JSON (K-802)
kitshn deploy --server <address> [--dir <app>]   deploy from GitHub Actions (K-803)`);
}
