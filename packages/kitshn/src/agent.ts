// K-1116 to K-1128: the commands that agents use on kitshn: publish, address, logs, repo and redirect. One transport
// carries their calls to `/agent`: an agent key's service token, or the local daemon, which adds the machine identity
// (K-1714), so an agent on a joined machine needs no token.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { type AssetSession, uploadAssets } from "./assets.ts";
import { CliError, fail } from "./cli-error.ts";
import { type DeployRun, type LogAnswer, logArgs, logLineText, logRange } from "./logs.ts";
import { contentType } from "./media.ts";
import { cardOutput, errorOutput } from "./output.ts";
import { type HandoverAnswer, repoFiles } from "./repo-files.ts";
import { KITSHN_RELEASE, skillText, versionedSkill } from "./skill.ts";

/** One call to an `/agent` path of kitshn. */
export interface AgentTransport {
  /** The address of kitshn, for the files of a new repo (K-1127). */
  readonly server: () => Promise<string>;
  readonly call: (
    path: string,
    init: {
      readonly method: "GET" | "POST" | "DELETE";
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Uint8Array;
    },
  ) => Promise<Response>;
}

/** K-1116: an agent key: its service token from CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, on `server`. */
export function keyTransport(server: string): AgentTransport {
  if (!server)
    fail("name the kitshn server with --server or KITSHN_SERVER, for example https://kit.example.com.");
  const id = process.env["CF_ACCESS_CLIENT_ID"];
  const secret = process.env["CF_ACCESS_CLIENT_SECRET"];
  if (!id || !secret)
    fail(
      "on a joined machine, run kitshn of the machine; elsewhere set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to the service token of an agent key.",
    );
  const credentials = { "cf-access-client-id": id ?? "", "cf-access-client-secret": secret ?? "" };
  return {
    server: async () => server,
    call: (path, init) =>
      fetch(new URL(path, server), { ...init, headers: { ...credentials, ...init.headers } }),
  };
}

export const AGENT_COMMANDS = ["publish", "address", "logs", "repo", "redirect"] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];
export const isAgentCommand = (value: unknown): value is AgentCommand =>
  typeof value === "string" && (AGENT_COMMANDS as ReadonlyArray<string>).includes(value);

/** The help lines of the agent commands. */
export const AGENT_USAGE = `kitshn publish <file|folder> [--name <name>] [--address <name>] [--zone <zone>] [--circle <circle>] [--public] [--json]
                                             publish a page, a file (K-1116) or a folder site (K-1123)
kitshn address <card> <name> [--json]        give a page, a file (K-1120) or a folder site (K-1124) a new address name
                                             --json prints one JSON object on stdout: the card, or {"error"}
kitshn logs <card> [text] [--since 1h | --from <time> [--to <time>]] [--deploys] [--json] [-- <text>]
                                             search the logs of a card that you manage (K-1809)
kitshn repo <card> [<folder|file>] --repo <owner/name>
                                             make a new repo of a page or a folder site with gh (K-1127)
kitshn redirect <card> <address> [--remove] [--json]
                                             a hostname that only sends visitors on to a site card (K-1128)`;

/** K-1809: with `--json`, stdout holds only the result object; progress and notes go to stderr. */
let json = false;

/** K-1116, K-1120, K-1123: one JSON call to an `/agent` path. */
async function agentCall<T>(t: AgentTransport, path: string, body: object): Promise<T> {
  const response = await t.call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !data) fail(data?.error ?? `${path} answered ${response.status}.`);
  return data as T;
}

interface PublishOptions {
  readonly name: string;
  readonly circle: string;
  readonly address: string;
  readonly zone: string;
  readonly open: boolean;
}

/**
 * K-1116: `kitshn publish <file>` sends the file to `/agent/library`. The same name again updates the card and keeps
 * the previous version (K-1117).
 */
async function publish(t: AgentTransport, file: string, options: PublishOptions) {
  if (!existsSync(file)) fail(`${file} does not exist.`);
  if (statSync(file).isDirectory()) return publishFolder(t, file, options);
  if (options.zone) fail("--zone is for a folder site; a page or a file lives on the kitshn zone.");
  const { name, circle, address, open } = options;
  const body = readFileSync(file);
  const fileName = name || file.slice(file.lastIndexOf(sep) + 1);
  const headers: Record<string, string> = {
    "x-kitshn-name": encodeURIComponent(fileName),
    "content-type": contentType(fileName),
  };
  if (circle) headers["x-kitshn-circle"] = encodeURIComponent(circle);
  if (address) headers["x-kitshn-address"] = encodeURIComponent(address);
  if (open) headers["x-kitshn-public"] = "true";
  const response = await t.call("/agent/library", { method: "POST", headers, body });
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    id?: string;
    address?: string | null;
    updated?: boolean;
    revision?: number | null;
  } | null;
  if (!response.ok) fail(data?.error ?? `/agent/library answered ${response.status}.`);
  if (json)
    return void process.stdout.write(
      cardOutput({
        address: data?.address,
        card: data?.id,
        kind: fileName.toLowerCase().endsWith(".html") ? "page" : "file",
        updated: data?.updated === true,
        revision: data?.revision ?? null,
      }),
    );
  console.log(
    `kitshn: ${data?.updated ? "updated" : "published"} ${fileName}${data?.address ? ` at https://${data.address}` : ""}`,
  );
}

/**
 * K-1123: a folder becomes a static site at `<name>.<zone>`, in the steps of a repo deploy: plan, the upload of the
 * files straight to Cloudflare, finish. The same folder name again deploys the same site.
 */
async function publishFolder(t: AgentTransport, folder: string, options: PublishOptions) {
  const name = options.name || resolve(folder).slice(resolve(folder).lastIndexOf(sep) + 1);
  const plan = await agentCall<{ deployId: string; card: string; address: string; updated: boolean }>(
    t,
    "/agent/sites/plan",
    {
      folder: name,
      circle: options.circle,
      address: options.address,
      zone: options.zone,
      public: options.open,
    },
  );
  const assets = await uploadAssets(folder, (manifest) =>
    agentCall<AssetSession>(t, "/agent/sites/assets", { deployId: plan.deployId, manifest }),
  );
  const done = await agentCall<{ address: string; status: number }>(t, "/agent/sites/finish", {
    deployId: plan.deployId,
    jwt: assets.jwt,
    icon: assets.icon,
    headers: assets.headers,
    redirects: assets.redirects,
  });
  if (json)
    return void process.stdout.write(
      cardOutput({ address: done.address, card: plan.card, kind: "folder", updated: plan.updated }),
    );
  console.log(
    `kitshn: ${plan.updated ? "updated" : "published"} ${name} (${assets.count} files) at https://${done.address} (answered ${done.status})`,
  );
}

/** K-1120: gives a page or a file card, by its id or its address name, a new address name. */
async function setAddress(t: AgentTransport, card: string, name: string) {
  const data = await agentCall<{
    address: string;
    card: string;
    kind: "page" | "file" | "folder";
    revision: number | null;
  }>(t, `/agent/cards/${encodeURIComponent(card)}/address`, {
    address: name,
  });
  if (json)
    return void process.stdout.write(
      cardOutput({
        address: data.address,
        card: data.card,
        kind: data.kind,
        updated: true,
        revision: data.revision,
      }),
    );
  console.log(`kitshn: ${card} is now at https://${data.address}`);
}

/** K-1809: an agent key searches the logs of a card that it controls (K-1810); no Live, which needs the map. */
async function logs(
  t: AgentTransport,
  card: string,
  text: string,
  range: { from: number; to: number },
  options: { deploys: boolean; json: boolean },
) {
  const answer = await agentCall<{ answer?: LogAnswer; runs?: ReadonlyArray<DeployRun> }>(t, "/agent/logs", {
    card,
    tab: options.deploys ? "deploys" : "app",
    text,
    from: range.from,
    to: range.to,
  });
  // An error answer fails (exit 1), also with --json, where the catch prints it as {"error"} (K-1809).
  const found = answer.answer;
  if (found?.state === "error") fail(found.error);
  if (found?.state === "needs-permission")
    fail('search in Worker logs needs the token permission "Workers Observability: Edit" (K-1806).');
  // With --json, stdout holds only the answer; console.log goes to stderr in that mode.
  if (options.json) return void process.stdout.write(`${JSON.stringify(found ?? answer.runs)}\n`);
  if (options.deploys) {
    for (const run of answer.runs ?? []) {
      console.log(
        `${new Date(run.at).toISOString()} ${run.sha.slice(0, 7)} ${run.state}${run.reason ? ` ${run.reason}` : ""}${run.runUrl ? ` ${run.runUrl}` : ""}`,
      );
      for (const line of run.lines ?? []) console.log(`  ${line}`);
    }
    return;
  }
  if (!found) fail("kitshn sent no answer.");
  if (found?.state !== "lines") return;
  for (const line of found.lines) console.log(logLineText(line));
  if (found.cut)
    console.error(
      "kitshn: the search stopped at 15 s, so the newest lines may be missing; narrow the range.",
    );
  else if (found.matched > found.lines.length)
    console.error(`kitshn: the newest ${found.lines.length} of ${found.matched} lines that match.`);
}

/**
 * K-1127: makes a new GitHub repo of a page or a folder site with the user's own `gh` login, and hands the card over
 * to it by the repo's ids: the repo's first push deploys the same card. The files come from `path`; for a page
 * without one, from kitshn.
 */
async function makeRepo(t: AgentTransport, card: string, path: string, repo: string) {
  const gh = (...ghArgs: Array<string>) => execFileSync("gh", ghArgs, { encoding: "utf8" }).trim();
  // A new repo only: the handover is for the repo that this command makes.
  const known = spawnSync("gh", ["repo", "view", repo, "--json", "name"], { stdio: "ignore" });
  if (known.error) fail("install the GitHub CLI and log in with gh auth login.");
  if (known.status === 0) fail(`${repo} exists already; name a new repo.`);
  if (path && !existsSync(path)) fail(`${path} does not exist.`);
  gh("repo", "create", repo, "--private");
  const [repoId = "", ownerId = ""] = gh("api", `repos/${repo}`, "--jq", ".id, .owner.id").split("\n");
  let handover: HandoverAnswer;
  try {
    handover = await agentCall<HandoverAnswer>(t, `/agent/cards/${encodeURIComponent(card)}/handover`, {
      repo,
      repoId,
      ownerId,
    });
  } catch (error) {
    console.error(
      `kitshn: ${repo} is made but empty; delete it with gh repo delete ${repo} if you do not need it.`,
    );
    throw error;
  }
  const dir = mkdtempSync(join(tmpdir(), "kitshn-repo-"));
  try {
    const site = join(dir, "site");
    mkdirSync(site);
    if (path && statSync(path).isDirectory())
      cpSync(path, site, {
        recursive: true,
        filter: (from) =>
          !relative(path, from)
            .split(sep)
            .some((part) => part.startsWith(".")),
      });
    else if (path && handover.kind === "page") cpSync(path, join(site, "index.html"));
    else if (path) fail(`${path} is a file; a folder site becomes a repo from its folder.`);
    else if (handover.kind === "page") {
      const page = await t.call(`/agent/library/${encodeURIComponent(handover.card)}/content`, {
        method: "GET",
      });
      if (!page.ok) fail(`kitshn did not send the page: ${page.status}.`);
      writeFileSync(join(site, "index.html"), Buffer.from(await page.arrayBuffer()));
    } else fail("name the folder of the site: kitshn cannot read the files of a folder site back.");
    const skill = versionedSkill(skillText(), KITSHN_RELEASE, "repo");
    for (const [file, text] of Object.entries(repoFiles(handover, repo, await t.server(), skill))) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const git = (...gitArgs: Array<string>) => execFileSync("git", gitArgs, { cwd: dir, stdio: "inherit" });
    git("init", "--quiet", "--initial-branch", "main");
    git("add", "--all");
    git("commit", "--quiet", "--message", `kitshn: ${repo} from its kitshn card`);
    // The user's gh login pushes, so the first deploy comes from the user's push.
    git(
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "--quiet",
      `https://github.com/${repo}.git`,
      "main",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    `kitshn: made ${repo}; its first push deploys the card at https://${handover.addresses[0] ?? ""} (K-1127).`,
  );
}

/** K-1128: adds a hostname that only sends visitors on to a site card, or with `remove` takes it away again. */
async function redirect(t: AgentTransport, card: string, address: string, remove: boolean) {
  const path = `/agent/cards/${encodeURIComponent(card)}/redirects`;
  const response = await t.call(remove ? `${path}/${encodeURIComponent(address)}` : path, {
    method: remove ? "DELETE" : "POST",
    headers: { "content-type": "application/json" },
    ...(remove ? {} : { body: JSON.stringify({ address }) }),
  });
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    card?: string;
    address?: string;
    to?: string;
    revision?: number;
  } | null;
  if (!response.ok || !data) fail(data?.error ?? `${path} answered ${response.status}.`);
  if (json) return void process.stdout.write(`${JSON.stringify({ ...data, removed: remove })}\n`);
  console.log(
    remove
      ? `kitshn: ${address} no longer sends visitors on to ${card}.`
      : `kitshn: ${address} sends visitors on to https://${data?.to ?? ""} once its domain is up (K-1128).`,
  );
}

/**
 * Runs one agent command and exits on an error: 1 for a refused step, 2 for bad arguments (K-1809). With `--json`,
 * the reason is the one object on stdout.
 */
export async function runAgentCommand(
  command: AgentCommand,
  args: ReadonlyArray<string>,
  transport: () => AgentTransport,
) {
  json = args.includes("--json");
  if (json) console.log = console.error.bind(console);
  const flag = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  const usage = (reason: string): never => {
    if (json) process.stdout.write(errorOutput(reason));
    console.error(`kitshn: ${reason}`);
    process.exit(2);
  };
  try {
    const t = transport();
    if (command === "publish") {
      const valued = new Set(["--name", "--circle", "--address", "--zone", "--server"]);
      const file = args.find((arg, index) => !arg.startsWith("--") && !valued.has(args[index - 1] ?? ""));
      if (!file)
        fail(
          "name the file or folder to publish: kitshn publish <file|folder> [--name <name>] [--address <name>] [--zone <zone>] [--circle <circle>] [--public].",
        );
      await publish(t, file ?? "", {
        name: flag("--name", ""),
        circle: flag("--circle", ""),
        address: flag("--address", ""),
        zone: flag("--zone", ""),
        open: args.includes("--public"),
      });
    } else if (command === "logs") {
      const { card, text } = logArgs(args);
      if (!card)
        usage(
          "name the card: kitshn logs <card> [text] [--since 1h | --from <time> [--to <time>]] [--deploys] [--json] [-- <text>].",
        );
      const range = logRange(
        { since: flag("--since", ""), from: flag("--from", ""), to: flag("--to", "") },
        Date.now(),
      );
      if (typeof range === "string") usage(range);
      await logs(t, card ?? "", text, range as { from: number; to: number }, {
        deploys: args.includes("--deploys"),
        json: args.includes("--json"),
      });
    } else if (command === "redirect") {
      const [card, address] = args.filter(
        (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--server",
      );
      if (!card || !address)
        fail("name the site card and the hostname: kitshn redirect <card> <address> [--remove].");
      await redirect(t, card ?? "", address ?? "", args.includes("--remove"));
    } else if (command === "address") {
      const [card, name] = args.filter(
        (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--server",
      );
      if (!card || !name) fail("name the card and its new address name: kitshn address <card> <name>.");
      await setAddress(t, card ?? "", name ?? "");
    } else if (command === "repo") {
      const valued = new Set(["--repo", "--server"]);
      const [card, path] = args.filter(
        (arg, index) => !arg.startsWith("--") && !valued.has(args[index - 1] ?? ""),
      );
      const repo = flag("--repo", "");
      if (!card || !repo)
        fail("name the card and the new repo: kitshn repo <card> [<folder|file>] --repo <owner/name>.");
      await makeRepo(t, card ?? "", path ?? "", repo);
    }
  } catch (error) {
    if (json) {
      process.stdout.write(errorOutput(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
    if (!(error instanceof CliError)) throw error;
    console.error(`kitshn: ${error.message}`);
    process.exit(1);
  }
}
