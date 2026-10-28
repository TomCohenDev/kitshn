#!/usr/bin/env node
// The kitshn CLI for app repos: `kitshn check` (K-802) and `kitshn deploy` (K-803, K-805, K-811).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { headersWarnings, redirectsWarnings } from "./headers.ts";
import { pickSiteIcon } from "./icon.ts";
import { RecipeError, readRecipe } from "./parse.ts";
import { type DeployEvent, type WorkerApp, decodeRecipe } from "./recipe.ts";

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
let cachedToken: { readonly value: string; readonly until: number } | null = null;

async function oidcToken(audience: string): Promise<string> {
  // A token lasts about 5 minutes; a deploy that waits asks for one every few seconds.
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.value;
  const url = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const token = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!url || !token) fail("no GitHub OIDC token. The workflow needs `permissions: id-token: write`.");
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${token}` },
  });
  const body = (await response.json()) as { value?: string };
  if (!body.value) fail(`GitHub gave no OIDC token (${response.status}).`);
  cachedToken = { value: body.value as string, until: Date.now() + 4 * 60_000 };
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
  // K-718: a dispatch runs one branch's code, so it deploys as a push of that branch.
  if (name === "push" || name === "workflow_dispatch")
    return { name: "push", branch: process.env["GITHUB_REF_NAME"] ?? "", pr: null, action: null };
  return fail(`kitshn deploys on push, pull_request and workflow_dispatch, not on ${name}.`);
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
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".gpx": "application/gpx+xml",
  ".webmanifest": "application/manifest+json",
};

/** K-805, K-806: plans the deploy, then deploys the recipe's kind. */
async function deploy(server: string, dir: string) {
  const env = params();
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
  if ("compose" in recipe) return deployCompose(server, dir, plan.deployId, plan.plan.address ?? "", env);
  if ("worker" in recipe) return deployWorker(server, dir, plan.deployId, recipe.worker, env);
  if (recipe.static.build) runBuild(dir, recipe.static.build);
  const output = resolve(dir, recipe.static.output);
  // K-805: a site that its own job built arrives at artifact-path, which must be the output folder of the recipe.
  const artifactPath = process.env["KITSHN_ARTIFACT_PATH"];
  if (artifactPath && resolve(dir, artifactPath) !== output) {
    fail(
      `the artifact went to ${artifactPath}, but the output folder of the recipe is ${recipe.static.output}. Make artifact-path and output the same folder.`,
    );
  }
  if (artifactPath && recipe.static.build)
    console.log(
      "kitshn: warning: the recipe builds too, over the artifact; a site with its own build job names no build.",
    );
  const assets = await uploadAssets(server, dir, plan.deployId, recipe.static.output);
  const done = await call<{ address: string; status: number; card: string }>(server, "/deploy/finish", {
    deployId: plan.deployId,
    jwt: assets.jwt,
    icon: assets.icon,
    headers: assets.headers,
    redirects: assets.redirects,
  });
  console.log(
    `kitshn: deployed ${assets.count} files to https://${done.address} (route check: ${done.status}).`,
  );
  console.log(`kitshn: ${done.card}`);
}

/**
 * The environment of the build command and of npx: without the two variables that mint GitHub OIDC tokens, so code
 * of the repo and of npm packages cannot ask for a token of this run.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  delete env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  return env;
}

function runBuild(dir: string, command: string) {
  console.log(`kitshn: building with: ${command}`);
  execFileSync("sh", ["-c", command], { cwd: dir, stdio: "inherit", env: childEnv() });
}

/** A path of the recipe after symlinks, or a failure when it leaves the repo. */
function insideRepo(dir: string, path: string, what: string): string {
  const full = resolve(dir, path);
  // realpath follows a symlink, so a link cannot point outside the repo.
  const real = existsSync(full) ? realpathSync(full) : full;
  const root = realpathSync(dir);
  if (real !== root && !real.startsWith(root + sep)) fail(`${what} ${path} is outside the repo.`);
  if (!existsSync(full)) fail(`${what} ${path} does not exist after the build.`);
  return full;
}

/**
 * K-805: uploads a folder of files through the Workers direct upload flow, and picks the card icon (K-1112).
 * `_headers` and `_redirects` are config that Cloudflare reads, not files to serve.
 */
async function uploadAssets(server: string, dir: string, deployId: string, folder: string) {
  const output = insideRepo(dir, folder, "the output folder");
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, { path: string; type: string }>();
  const byPath = new Map<string, string>();
  let headers: string | null = null;
  let redirects: string | null = null;
  for (const path of files(output)) {
    if (relative(output, path) === "_headers") {
      headers = readFileSync(path, "utf8");
      for (const warning of headersWarnings(headers)) console.log(`kitshn: warning: ${warning}`);
      continue;
    }
    if (relative(output, path) === "_redirects") {
      redirects = readFileSync(path, "utf8");
      for (const warning of redirectsWarnings(redirects)) console.log(`kitshn: warning: ${warning}`);
      continue;
    }
    const bytes = readFileSync(path);
    const extension = extname(path).toLowerCase();
    const hash = createHash("sha256")
      .update(bytes.toString("base64") + extension.slice(1))
      .digest("hex")
      .slice(0, 32);
    const sitePath = `/${relative(output, path).split("\\").join("/")}`;
    manifest[sitePath] = { hash, size: bytes.length };
    byPath.set(sitePath, path);
    byHash.set(hash, { path, type: TYPES[extension] ?? "application/octet-stream" });
  }
  if (Object.keys(manifest).length === 0) fail(`the output folder ${folder} is empty.`);
  const session = await call<{ jwt: string; buckets: Array<Array<string>>; uploadUrl: string }>(
    server,
    "/deploy/assets",
    { deployId, manifest },
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
  // K-1112: the card icon comes from the files; a site without one gets its kind icon.
  const { icon, notes } = await pickSiteIcon((path) => {
    const file = byPath.get(path);
    return file === undefined ? null : readFileSync(file);
  });
  for (const note of notes) console.log(`kitshn: icon: ${note}`);
  console.log(
    icon
      ? `kitshn: the card icon is ${icon.path}.`
      : "kitshn: the site has no icon; the card shows the kind icon.",
  );
  if (headers !== null) console.log("kitshn: the site sets its own headers with _headers.");
  if (redirects !== null) console.log("kitshn: the site sets its own redirects with _redirects.");
  return {
    jwt: completion,
    icon: icon ? Buffer.from(icon.bytes).toString("base64") : null,
    headers,
    redirects,
    count: Object.keys(manifest).length,
  };
}

/**
 * K-806: the esbuild that bundles Worker apps, pinned. Known limit: npx downloads it from npm in each deploy, so a
 * deploy needs the npm registry and trusts that package. Revisit when that download fails a deploy, or when the
 * kitshn release can ship esbuild itself.
 */
const ESBUILD = "esbuild@0.28.2";

/** K-806: the Free plan limit of a Worker, gzip-compressed. */
const WORKER_GZIP_LIMIT = 3 * 1024 * 1024;

/**
 * K-806: bundles `main` into one ES module, uploads the assets folder, and sends both with the `KITSHN_<NAME>` values
 * of the run (K-808). kitshn makes the storage of the environment and the Worker.
 */
async function deployWorker(
  server: string,
  dir: string,
  deployId: string,
  app: WorkerApp,
  env: ReadonlyMap<string, string>,
) {
  if (process.env["KITSHN_ARTIFACT_PATH"])
    fail("artifact and artifact-path are for static sites; a Worker app builds with `build` (K-806).");
  if (app.build) runBuild(dir, app.build);
  const main = insideRepo(dir, app.main, "the entry module");
  const work = mkdtempSync(join(tmpdir(), "kitshn-worker-"));
  try {
    const outfile = join(work, "worker.js");
    const metafile = join(work, "meta.json");
    console.log(`kitshn: bundling ${app.main} with ${ESBUILD}`);
    // From the temporary folder and the public registry, so the .npmrc and node_modules of the repo do not choose
    // the esbuild that runs.
    execFileSync(
      "npx",
      [
        "--yes",
        "--registry=https://registry.npmjs.org",
        ESBUILD,
        main,
        "--bundle",
        "--format=esm",
        "--platform=neutral",
        "--conditions=workerd,worker,browser",
        "--main-fields=module,main",
        "--external:cloudflare:*",
        "--external:node:*",
        `--outfile=${outfile}`,
        `--metafile=${metafile}`,
        "--log-level=warning",
      ],
      { cwd: work, stdio: "inherit", env: childEnv() },
    );
    const module = readFileSync(outfile, "utf8");
    const size = gzipSync(module).length;
    if (size > WORKER_GZIP_LIMIT)
      fail(
        `the bundle is ${Math.round(size / 1024)} KB gzip-compressed; a Worker on the Free plan takes 3 MB.`,
      );
    const meta = JSON.parse(readFileSync(metafile, "utf8")) as {
      outputs: Record<string, { exports?: ReadonlyArray<string> }>;
    };
    const exports = new Set(Object.values(meta.outputs).flatMap((output) => output.exports ?? []));
    for (const [binding, name] of Object.entries(app.durableObjects ?? {}))
      if (!exports.has(name))
        fail(`${app.main} exports no class ${name} for the Durable Object binding ${binding}.`);
    const storage = await call<{ created: ReadonlyArray<string> }>(server, "/deploy/storage", { deployId });
    for (const name of storage.created) console.log(`kitshn: made the KV namespace of ${name}.`);
    const assets = app.assets ? await uploadAssets(server, dir, deployId, app.assets.folder) : null;
    const done = await call<{ address: string; status: number; card: string; notes: ReadonlyArray<string> }>(
      server,
      "/deploy/finish",
      {
        deployId,
        jwt: assets?.jwt ?? null,
        icon: assets?.icon ?? null,
        headers: assets?.headers ?? null,
        redirects: assets?.redirects ?? null,
        module,
        secrets: Object.fromEntries(env),
      },
    );
    for (const note of done.notes) console.log(`kitshn: ${note}`);
    console.log(
      `kitshn: deployed the Worker (${Math.round(size / 1024)} KB gzip-compressed${assets ? `, ${assets.count} files` : ""}) to https://${done.address} (route check: ${done.status}).`,
    );
    console.log(`kitshn: ${done.card}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The largest source archive kitshn takes (K-812): under the 100 MB request body limit of Cloudflare. */
const MAX_ARCHIVE = 95 * 1024 * 1024;

/** KitSHn 1 deploy credentials that live next to app params in old repos; an app never gets them. */
const INFRASTRUCTURE = new Set(["SSH_KEY", "VPS_HOST", "SSH_KNOWN_HOSTS"]);

/**
 * K-808: the `KITSHN_<NAME>` secrets and variables of the run by `<NAME>`. The workflow filters them into a file in
 * an earlier step, so build commands never see secrets; a secret wins over a variable with the same name.
 */
function params(): Map<string, string> {
  const file = process.env["KITSHN_PARAMS_JSON"];
  delete process.env["KITSHN_PARAMS_JSON"];
  if (!file) return new Map();
  if (!existsSync(file)) fail(`the params file ${file} is missing; the workflow and the CLI do not match.`);
  const text = readFileSync(file, "utf8");
  // Gone before any build command runs, so a build cannot read the secrets.
  rmSync(file, { force: true });
  const read = JSON.parse(text) as {
    secrets?: Record<string, unknown>;
    vars?: Record<string, unknown>;
  };
  const values = new Map<string, string>();
  for (const source of [read.vars ?? {}, read.secrets ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      const name = key.slice("KITSHN_".length);
      const named =
        name.length > 0 &&
        [...name].every((c) => c === "_" || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9"));
      if (!key.startsWith("KITSHN_") || !named || typeof value !== "string" || INFRASTRUCTURE.has(name))
        continue;
      values.set(name, value);
    }
  }
  return values;
}

/** K-808: Compose env lines `<NAME>="value"`, quoted as JSON like KitSHn 1, so a line break or a `#` survives. */
const envLines = (values: ReadonlyMap<string, string>) =>
  [...values].map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n");

async function upload(server: string, path: string, deployId: string, body: Buffer, type: string) {
  const response = await fetch(new URL(path, server), {
    method: "POST",
    headers: {
      "content-type": type,
      "x-kitshn-deploy": deployId,
      authorization: `Bearer ${await oidcToken(new URL(server).origin)}`,
    },
    body,
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) fail(data?.error ?? `${path} answered ${response.status}.`);
}

/**
 * K-812, K-813: sends the checkout and the params to R2 for this deploy, starts the job on a machine, and
 * prints its output until it ends. The checkout keeps `.git`, because builds can read it; the workflow
 * checks out without a stored token.
 */
async function deployCompose(
  server: string,
  dir: string,
  deployId: string,
  address: string,
  values: ReadonlyMap<string, string>,
) {
  const env = envLines(values);
  const archive = execFileSync("tar", ["-czf", "-", "--exclude=./node_modules", "-C", dir, "."], {
    maxBuffer: MAX_ARCHIVE + 1,
  });
  if (archive.length > MAX_ARCHIVE) fail("the source archive is larger than 95 MB.");
  console.log(`kitshn: sending the source (${Math.round(archive.length / 1024)} KB)`);
  await upload(server, "/deploy/archive", deployId, archive, "application/gzip");
  await upload(server, "/deploy/params", deployId, Buffer.from(env), "text/plain");
  const started = await call<{ machine: string }>(server, "/deploy/start", { deployId });
  console.log(`kitshn: building and starting on ${started.machine}`);
  let shown = 0;
  // The workflow stops at 40 minutes; a deploy that has not ended by then failed somewhere.
  const until = Date.now() + 38 * 60_000;
  for (;;) {
    if (Date.now() > until) fail("the deploy did not end within 38 minutes.");
    await new Promise((done) => setTimeout(done, 3000));
    const status = await call<{ state: string; output: string; exitCode: number | null }>(
      server,
      "/deploy/status",
      { deployId },
    );
    if (status.output.length > shown) {
      process.stdout.write(status.output.slice(shown));
      shown = status.output.length;
    }
    if (status.state === "done") break;
    if (status.state === "failed" || status.state === "expired")
      fail(`the deploy ${status.state} (exit code ${status.exitCode ?? "none"}).`);
  }
  console.log(`\nkitshn: deployed to https://${address}`);
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
