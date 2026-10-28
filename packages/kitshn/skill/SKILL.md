---
name: kitshn
description: Deploy an app repo with kitshn 2, publish pages and files as an agent, or debug a failed kitshn deploy. Use when a repo has or needs kitshn.config.ts, when a task names kitshn, kit.yarden-zamir.com or a kitshn card, circle or deploy. Not for KitSHn 1 repos with .kitshn.yaml.
license: MIT
---

# kitshn

kitshn 2 deploys apps from GitHub to Cloudflare and to the owner's machines. A map decides who can open each app: a card inside a circle is shared with that circle. The admin and the map are at `kit.<zone>`, for Yarden `https://kit.yarden-zamir.com`.

The source of truth is [SPEC.md](https://github.com/Yarden-zamir/kitshn/blob/main/SPEC.md). Its `K-` numbers name each rule. Read the requirement before you rely on a detail here. `kitshn --help` lists the commands of the CLI that you have.

A repo with `.kitshn.yaml` and `Caddyfile.j2` is a KitSHn 1 repo. Do not mix the two. To move one, see "Move from KitSHn 1" at the end.

## The two programs named `kitshn`

- **App CLI** (`kitshn.mjs` in each `edge-<version>` release): `check`, `deploy`, and for agent keys `publish` and `address`. GitHub Actions downloads it; you rarely run it by hand.
- **Daemon** (one binary per machine, installed by the join command): `status`, `expose`, `unexpose`, `join`, `rekey`. See `kitshn` with no arguments on a machine.

## Add kitshn to an app repo

1. Write `kitshn.config.ts` at the repo root. The value is one object literal: no loops, conditions, calls or other imports (K-802). kitshn reads it as data and never runs it (K-803).

   ```ts
   import { defineApps } from "kitshn";

   export default defineApps({
     web: {
       static: { build: "npm ci && npm run build", output: "dist" },
       needs: { apps: ["api"] },
       deploy: [
         { on: "push", branch: "main", name: "prod", address: ["web.example.com", "example.org"], startsIn: "Everyone" },
         { on: "pull_request", name: "pr-{pr}", ephemeral: true },
       ],
     },
     api: {
       compose: { runsOn: ["docker"] },
       deploy: [{ on: "push", branch: "main", name: "prod" }],
     },
   });
   ```

   - One app: `export default defineApp({ ... })`. Several: `defineApps`, up to 10, keys like `web` (K-804).
   - Kinds, one per app: `static` (`build`, `output`, K-805), `compose` (`runsOn` machine labels, `file`, K-812, K-818) or `worker` (`main`, `compatibilityDate`, `kv`, `durableObjects`, `crons`, `vars`, `assets`, K-806).
   - `deploy`: the first matching entry wins (K-807). `pr-{pr}` gives each pull request a preview (K-901).
   - `address`: the default is `<repo>[-<key>][-<env>].<zone>`. A push entry may list up to 5; the first must be under the kitshn zone (K-817).
   - `startsIn`: the circle of a new card. Without it, the card waits private in the tray. After the first deploy, the map decides (K-518).
   - `needs.apps`: deploy after those apps of the same file, and skip when one of them failed (K-820).
2. Run `npx -y https://github.com/Yarden-zamir/kitshn/releases/download/edge/kitshn.tgz check` (or `node kitshn.mjs check`). It prints the recipe as JSON or names the mistake.
3. Add a workflow, for example `.github/workflows/kitshn.yml`. Any file name works: Allow starts the file of the waiting push run again (K-1121).

   ```yaml
   on:
     push:
     pull_request:
       types: [opened, synchronize, reopened, closed]
     workflow_dispatch:
   permissions:
     contents: read
     id-token: write
   jobs:
     kitshn:
       uses: Yarden-zamir/kitshn/.github/workflows/kitshn2-deploy.yml@main
       secrets: inherit
   ```

   A build that needs its own job, or runs untrusted code, uploads an artifact; the header of `kitshn2-deploy.yml` shows the pattern (K-805).
4. Values: a GitHub secret or variable `KITSHN_<NAME>` reaches the app as `<NAME>` (K-808). Put production-only secrets in the GitHub Environment `prod`.
5. Push. The first deploy of a new repo waits: "waits on the kitshn map" (K-819). The owner clicks **Allow**, or an agent key with "may add apps" sends `{"state": "allowed"}` to `POST kit.<zone>/agent/repos/<repoId>` (the id is in `GET kit.<zone>/agent/state`).

A Compose app listens on the Unix socket `$KITSHN_DEFAULT_SOCKET` and publishes no ports (K-607). Only safe Compose keys pass; the deploy output names each refused setting, and only the owner can allow one on a machine (K-818).

## Agent keys: publish pages, files and folders

After [#115](https://github.com/Yarden-zamir/kitshn/pull/115) merges. An agent key is a Cloudflare Access service token. Set `KITSHN_SERVER`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`, then:

- `kitshn publish <file> [--name <name>] [--circle <circle>] [--public]` puts a page or a file on the map (K-1116). The same file name again updates its card (K-1117).
- After [#118](https://github.com/Yarden-zamir/kitshn/pull/118): `--address <name>` and `kitshn address <card> <name>` set a readable address, `pages.<zone>/<name>` (K-1120).
- After [#121](https://github.com/Yarden-zamir/kitshn/pull/121): `kitshn publish <folder>` publishes a static site with no repo (K-1123).

A key never raises access on its own: `--public` needs "may publish" (K-718).

## Rollback and badges

- "Roll back…" on a card, in its panel, menu or the command palette, returns it to one of its last deploys (K-821).
- A README badge: `![kitshn](https://kit.<zone>/public/badges/<owner>/<repo>.svg)`, with `?app=<key>&env=<name>` (K-1119). A private app shows `unknown`.

## Debug a failed deploy

Read the Actions log first: the deploy step prints the job output and the final address (K-813). Then:

| Message or sign | Cause and fix |
| --- | --- |
| "waits on the kitshn map" | First deploy of a repo (K-819). After Allow, a waiting push run starts again by itself (K-1121); run a pull request run again on GitHub. |
| A recipe error before any work | `kitshn check` names it. Fix `kitshn.config.ts`. |
| A missing value name | A needed `KITSHN_<NAME>` is not set (K-808). |
| A refused Compose setting | Remove it, or ask the owner to allow it for that machine (K-818). |
| An address that "already has a record" | Another card or a manual DNS record owns it (K-817). |
| No machine for the job | No online machine has the labels `deploy` and those of `runsOn` (K-610). |
| Preview refused near 90 scripts | Too many open previews (K-903). Close old pull requests. |
| The address shows "The kitchen is closed." | Nothing answers on the socket: the Compose app does not listen on `$KITSHN_DEFAULT_SOCKET`, or its machine is off (K-1106, K-1107). |
| The card shows "failed" with a reason | The card panel, under "Deploy", keeps the reason of each deploy (K-820). |

## Move from KitSHn 1

Replace `.kitshn.yaml` with `kitshn.config.ts`, and point the workflow at `kitshn2-deploy.yml`. Delete `Caddyfile.j2` and the `KITSHN_SSH_KEY` secret; kitshn 2 needs neither. The first deploy on the same machine takes over the KitSHn 1 data once (K-1404). Then move the DNS record of the address to kitshn.
