# KitSHn 2 spec

KitSHn 2 runs your apps, sites, pages, files and machines on Cloudflare, and decides who may open each one. It puts everything on one map. Circles on the map say who. A card inside a circle is shared with that circle.

The repo is named "KitSHn 2". "kit" is the short name of the project. Code, packages and the MCP tools use `kitshn`. The CLI is `kitshn`, with `kit` as a short alias. The admin and the map live at `kit.yarden-zamir.com` (K-1208).

Requirements have stable numbers with the prefix `K-`. Do not renumber them. Mark a removed requirement "Removed" and keep its number. `VERIFY:` marks a Cloudflare fact that the docs do not confirm; the first milestone that needs it tests it.

The architecture, the request paths and the budget are in [docs/architecture.md](docs/architecture.md). The order of work is in [docs/migration.md](docs/migration.md).

## Core rules

- **K-001** The app and what it needs to deploy live in its repo. The places (machines, the Cloudflare account, domains, who may open what) live in kitshn, never in the repo.
- **K-002** "Create a repo, push, and it deploys" stays true. A new app repo needs a recipe and a workflow file, and nothing else: no per-repo secret, no setup step in kitshn.
- **K-003** kitshn runs on Cloudflare only. Its logic and state run in one Worker with one Durable Object. Machines do only machine work: tunnels, local sites, Compose deploys, commands and builds.
- **K-004** kitshn fits the Cloudflare free plan for the setup of K-1301. A paid plan only raises limits; no feature needs it.
- **K-005** kitshn knows nothing about T3 Code. T3 Code and other programs add their own resource kinds through the local interface of section 7.
- **K-006** Every unexpected state fails closed: a request that kitshn cannot decide gets no access, and the error says why.

## Terms

- **Owner:** the person who installed kitshn. The owner is the first member of the "Owner" circle.
- **Circle:** a named group of who: people (emails), email domains, devices, networks (IP ranges), machines, and the flag "needs passkey". A circle has a default level.
- **Resource:** something that kitshn can share: a machine, a site, a page, a file, an app, a thread. Each resource kind names its levels.
- **Card:** a resource on the map.
- **Share:** a card inside a circle. It gives the members of the circle the circle's default level on that resource, or the level of an override.
- **Level:** what a share allows. Each resource kind names its own ordered levels, for example `view`, `use`, `control`.
- **Daemon:** the `kitshn` program on a machine.
- **Provider:** a program on a machine that adds resource kinds through the daemon, for example T3 Code.
- **Recipe:** `kitshn.config.ts` in an app repo.
- **Environment:** one deployed copy of an app, for example `prod` or `pr-12`.
- **Job:** one piece of machine work, for example a Compose deploy.

## 1. Identity and login

- **K-101** Cloudflare Access does every login. kitshn has no login code and no password store.
- **K-102** People log in with the Access One-time PIN (an email code). GitHub is a second login method next to the email code. The passkey check of K-103 applies after either login method.
- **K-103** A circle with "needs passkey" asks for a passkey or a security key after the login, through Access independent MFA. [Independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/) supports biometrics (Touch ID, Face ID, Windows Hello) and security keys, per application and per policy.
- **K-104** kitshn administration is a resource of kind `kitshn.admin` with the level `control`. Its card sits in the "Owner" circle. The Owner circle has "needs passkey" on.
- **K-105** kitshn refuses every change that leaves the admin resource without a share to a circle that has at least one person and "needs passkey". This guard runs on every write: a drag, a circle edit, an undo, an agent tool and the pause (K-1504). It also refuses a share of the admin resource with a circle that has "everyone", because that circle compiles to an Access Bypass policy.
- **K-106** A device proves itself with an Access service token: one token per device, for example "Mac desktop app" or "Yarden's phone". A device is a circle member like a person.
- **K-107** A machine proves itself with its own service token (K-602). A machine is a circle member too, so a share can give one machine access to another resource.
- **K-108** Browser approvals of the machine map (browser keys, the Clients approval flow) do not exist in kitshn. A passkey or a device token replaces them.
- **K-109** Access sessions of the admin resource last 24 hours. Sessions of other resources last 30 days unless a circle sets a shorter time.
- **K-110** "Sign out everywhere" ends every Access session of the account through the Cloudflare API.
- **K-111** Zero Trust Free counts one seat per person who logs in, up to 50. kitshn turns on seat expiration in Zero Trust admin controls, set to 1 month, so guests who stop coming free their seat. [Seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/) runs the expiry once a day.
- **K-112** The admin view shows the seats in use, with a warning at 40. The removal of a seat stays in the dashboard, because the docs show no API for it. VERIFY: a user removal API.

## 2. Circles and shares

- **K-201** A circle has a name, a colour, a default level, members, a match mode (K-203), an optional end date, and the flag "needs passkey".
- **K-202** Member kinds: an email, an email domain, an IP range, a device token, a machine, and "everyone". "Everyone" means anyone who can reach the address, with no login.
- **K-203** A circle has one of two match modes:
  - "Any" (the default): the visitor matches at least one member. In Access, the members are include rules.
  - "All must match": the visitor matches every member, for example the domain `qlik.com` and the IP range of the Qlik network. In Access, the members are require rules. This replaces the "required IP ranges" of the machine map Guests view.

  With "needs passkey", the visitor must also pass a passkey check in both modes.
- **K-204** A card is shared with every circle that it sits inside. Circles overlap freely, and there is no limit on their number.
- **K-205** A share uses the default level of its circle. One card can override the level for one circle. The override shows as a chip on the card.
- **K-206** A level that the resource kind does not have becomes the highest level of that kind that is lower. A circle with the default `control` thus gives a file `view`.
- **K-207** When several circles match a visitor, the visitor gets the highest level of those shares.
- **K-208** A card outside every circle is private. Only the admin (K-104) can see it in the map.
- **K-209** A share can have an end date. At the end date, kitshn moves the card out of that circle as a new revision, and the history names the expiry.
- **K-210** A circle with "everyone" asks for confirmation the first time that a card enters it: "This makes <name> public."
- **K-211** The Owner circle and the Everyone circle exist from the start. The owner can rename them, and cannot delete the Owner circle.

## 3. Resources

- **K-301** Built-in resource kinds and their levels:

  | Kind | Levels | What it is |
  | --- | --- | --- |
  | `kitshn.admin` | control | kitshn administration (K-104) |
  | `machine` | view, use, control | a machine with a daemon (section 6) |
  | `site.static` | view | a static site on Workers static assets |
  | `site.worker` | view | a Worker app |
  | `site.compose` | view | a Compose app on a machine |
  | `site.live` | view | a local site of a machine, through its tunnel (K-1104) |
  | `page` | view | an HTML page in the library (section 10) |
  | `file` | view | a file in R2 |
  | `repo` | view | a repo that has a recipe; its environments are its children |

- **K-302** A provider adds kinds through the daemon (K-704). Each kind has an id with the provider prefix (for example `t3.thread`), its levels, and how it is enforced (K-405).
- **K-303** An environment of an app is its own resource and its own card, for example "riffle" and "riffle pr-41". New environments start in the circle that the recipe names (K-807).
- **K-304** Each resource has an id, a kind, a name, an owner machine when it has one, its addresses, and its status. The status is one of: running, stopped, deploying, failed, offline, unknown.

## 4. Enforcement

- **K-401** kitshn compiles shares into Cloudflare Access wherever Access can check them, so a check costs no Worker request.
- **K-402** Each circle becomes reusable Access policies: one for its people (Allow, with the passkey check), and one for its devices and networks (Service Auth), because Access lets service tokens and logins without a person in only through Service Auth. A resource with an address becomes one self-hosted Access application whose policies are the circles that hold it. VERIFY: the API attaches reusable policies to many applications. The account limits are 500 applications and 500 reusable policies ([account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)).
- **K-403** A resource inside "Everyone" gets a Bypass policy, or no Access application.
- **K-404** The Worker checks shares itself for what it serves: pages and files (section 10 and 11). It reads the Access JWT and the visitor IP, never a cookie of its own.
- **K-405** A provider enforces levels inside its own program. kitshn gives it a grant table for each of its resources (K-706). Access still guards the address: it lets in every circle with a level above none.
- **K-406** kitshn writes Access changes in a Durable Object alarm queue. One alarm run makes at most 40 Cloudflare API calls and sets the next alarm when work remains. The free plan allows 50 subrequests per request ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **K-407** The map shows a change at once. Each card shows "applying" until Cloudflare has the change, and "failed" with the reason if Cloudflare refuses it.
- **K-408** A daily alarm compares Access with the shares and repairs differences that kitshn made. It never changes an Access application or policy that kitshn did not make, and it names such an application when it covers a kitshn address.
- **K-409** A lower level takes effect at once: kitshn revokes the Access sessions of the affected application, and providers end the sessions of members that lost a level.

## 5. Map UX

The map is the main view. These requirements improve the demo of 2026-10-26.

- **K-501** The map shows every card and every circle. A toggle for each kind hides that kind. Hidden kinds still count for their circles.
- **K-502** A drag of a card, or of a selection, into or out of a circle shows a preview before the drop: each circle edge lights up, and a label says what changes, for example "+ Qlik · view" or "− Her". The drop applies it.
- **K-503** After each drop that changes a share, a toast names the change and has Undo for 10 seconds. Undo is also in the history (K-1502).
- **K-504** A drag of a circle by its head moves its cards with it. Alt and a drag moves the circle alone. The preview of K-502 then names every card that gains or loses the circle.
- **K-505** A resize of a circle shows the same preview as K-504 before the release.
- **K-506** A circle shows its members as chips on its edge, at most 4. A "+N" chip opens the full list.
- **K-507** A card shows a dot for each circle that holds it, and a chip for each override (K-205). A hover on a dot names the circle and the level.
- **K-508** Cards stack by group: the environments of one app, the pages of one thread, the files of one upload. A stack shows the top card and a count. A click spreads it in a row. A drag of a stack moves all its cards.
- **K-509** New cards arrive in a tray at the edge of the map, outside every circle, so they start private (K-208). Cards that a recipe places (K-807) skip the tray.
- **K-510** Multiselect: a box drag on empty space, Shift and a click, and "Select all of this kind" in the context menu. A selection moves as one.
- **K-511** The command palette (Cmd+K or Ctrl+K) finds every card, circle and action. "Share <card> with <circle>" works without a drag, also on a phone.
- **K-512** The card panel shows who can open the card: each circle, its members, the level, and the address. It has "Copy address" and "Open".
- **K-513** Zoomed out under 40%, cards become dots and each circle shows its counts by kind. The map never animates continuously, and a change plays at most one short transition.
- **K-514** Pan, zoom, fit and auto layout work as in the machine map (MM-1114 to MM-1121). Each device keeps its own view in local storage.
- **K-515** A card of an offline machine, or of an app on it, shows the "offline" sticker and the time since it was last seen.
- **K-516** The map works on a phone: a long press starts a drag, and the panel is a bottom sheet.
- **K-517** The map uses the tick3d look in light and dark mode (the `neo-brutalism` skill): lilac dotted canvas, ink borders, hard shadows, tilted stickers, Bricolage Grotesque.
- **K-518** Map state (places, circles, members, shares, stacks) lives in the kitshn database, never in Git (K-001).
- **K-519** Views next to the map: History (with presets, K-716), Queue, Seats, Machines (a table of status and health), Library (section 10). Each view and each selected item has its own link.

## 6. Machines and the daemon

- **K-601** Each machine runs one `kitshn` daemon as a system service: systemd on Linux, launchd on macOS. The first version has no Windows daemon. A Windows machine stays on the machine map portal until a later milestone ([docs/migration.md](docs/migration.md)).
- **K-602** "Add machine" creates a service token and a remotely managed tunnel, and shows a one-time join code that expires after 10 minutes. `kitshn join <code>` installs nothing else and saves the token and the tunnel token in a file that only the daemon user can read.
- **K-603** The daemon runs `cloudflared` for the tunnel of its machine. kitshn owns the tunnel ingress through the API; the daemon never edits it.
- **K-604** The daemon keeps one WebSocket to the Durable Object at `/connect`, with backoff after a failure. Liveness uses `ping` and `pong` with the Durable Object auto response, so a ping wakes nothing.
- **K-605** The daemon sends its status on connection and on each change, at most once every 5 seconds. It sends a resource sample (CPU, memory, disk) once a minute.
- **K-606** The Durable Object keeps only the latest sample of each machine, in memory. The daemon keeps 30 days of history on its disk and answers a history request. This keeps the daily writes low (K-1302).
- **K-607** Local sites use Unix sockets. A Compose service listens on `<deployment>/sockets/<name>.sock`, and the tunnel ingress sends its address to `unix:<path>`. Services publish no host ports. Caddy is not needed. The [ingress docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/) show `service: unix:/path` for local configuration files. VERIFY: a remotely managed tunnel accepts `unix:` in its API configuration.
- **K-608** For an app that cannot listen on a socket, the recipe names a port inside its Compose network, and the daemon adds a small socket proxy service. The machine still publishes no host port.
- **K-609** Each machine has labels, for example `docker`, `server`, `arm`, `laptop`. The owner sets one order of all machines.
- **K-610** A job names the labels that it needs. kitshn gives it to the first online machine in the order that has all of them. Without such a machine, the job waits in the queue until its expiry (K-613).
- **K-611** A running app stays on its machine. kitshn never moves it by itself. "Move to <machine>" in the card panel deploys it on the other machine and then removes the old copy.
- **K-612** Commands are jobs too. Built-in commands: restart the daemon, update the daemon, collect diagnostics, run a shell command. A provider adds its own commands (K-707).
- **K-613** A job for an offline machine waits. It has a delivery rule ("when online" or "when online and idle") and an expiry, by default 24 hours.
- **K-614** "Run a shell command" needs `control` on the machine. The member that sends it is in the history.
- **K-615** "Remove machine" deletes its service token, its tunnel, its DNS records and its queue. Its apps show as stopped with "Deploy elsewhere".
- **K-616** A whole machine can belong to another person. Example: a second VPS whose card sits in the circle "Her" with `use`, and in the Owner circle with `control`. Its provider shows everything on it to every member with `use`, including the owner's threads there. The owner accepted this.

## 7. Local interface for providers (T3 Code)

- **K-701** The daemon listens on a local Unix socket: `$XDG_RUNTIME_DIR/kitshn/kitshn.sock` on Linux, `~/Library/Application Support/kitshn/kitshn.sock` on macOS. Only the user of the daemon and members of the `kitshn` group can open it.
- **K-702** The socket speaks JSON lines: requests with an id, answers with the same id, and events with no id. The schema is TypeScript types with Effect Schema, published as the npm package `@kitshn/local`. Providers import the types; the daemon checks each message against them.
- **K-703** The interface pushes events. A provider subscribes once, then gets each change of its resources, grants and commands as an event. Nothing polls.
- **K-704** `register` names the provider, its resource kinds (K-302) and its commands. Each new connection registers again, so a provider restart needs no cleanup.
- **K-705** `upsert` and `remove` add, change and remove resources of the provider's kinds, with a name, a parent, addresses and a status.
- **K-706** For each resource of a provider, the daemon pushes a grant table: each circle with its match mode (K-203), its rules (an email, a domain, an IP range, a service token client id, a machine id) and its passkey flag, with its level. The provider decides a level with no call, from the JWT that Access put on the request.
- **K-707** The daemon passes a command for a provider as an event. The provider answers with the result. The daemon forwards it to kitshn.
- **K-708** `publishPage`, `publishFile` and `expose` let a provider add a page (section 10), a file, or a live site (K-1104) with one call.
- **K-709** A resource kind can carry a desired state: a JSON value that kitshn stores and pushes to every machine with that provider. kitshn does not read the value. T3 Code uses it for shared settings and themes. Each value is at most 64 KB.
- **K-710** A local round trip (request to answer) takes under 5 ms, and a change on the map reaches a provider in under 1 second when its machine is online.
- **K-711** The provider holds no Cloudflare credential. Only the daemon holds the machine token.
- **K-712** T3 Code side: the fork adds the interface in its own files, with one-line hooks in upstream files. It never breaks upstream code paths when the daemon is missing: then T3 Code runs as upstream.
- **K-713** T3 Code adds these kinds through the interface:

  | Kind | Levels | Notes |
  | --- | --- | --- |
  | `t3.app` | view, use, control | The T3 web app, desktop app connection and phone app connection of one machine. Levels map to the T3 scopes `read`, `standard`, `admin` of MM-302. |
  | `t3.thread` | view, send | One thread through upstream guest links. The circle is the guest list. |
  | `t3.agents` | use, exec | What agents on another machine may do on this machine. A machine member of a circle gets it. `use` means agent tools; `exec` adds `machine_exec` (MM-1908). |
  | `t3.settings` | none | Shared settings and themes as desired state (K-709). Not shareable; the map hides it. |

- **K-714** The T3 fork MCP tools get new names:

  | Machine map tool | kitshn tool |
  | --- | --- |
  | `machines_read` | `kitshn_read` |
  | `machines_set_access` | `kitshn_share` (put a card in or out of a circle, with a level) and `kitshn_circle` (create or change a circle) |
  | `machines_set_setting` | `kitshn_set_setting` |
  | `machines_command` | `kitshn_command` |
  | `machines_queue_cancel` | `kitshn_queue_cancel` |
  | `machines_undo` | `kitshn_undo` |
  | `machines_preset` | `kitshn_preset` (save, list or apply a preset, K-716) |
  | `machines_join` | `kitshn_join` |
  | `machines_resources` | `kitshn_resources` |
  | `machine_exec` | `kitshn_exec` |
  | (new) | `kitshn_publish` (page, file or site), `kitshn_expose` (a live site), `kitshn_deploy` (run a deploy) |

- **K-715** Agents never raise access. An agent change that adds a card to a circle, raises a level, or adds a circle member becomes a proposal for the owner. Changes that lower access apply at once. This keeps MM-803.
- **K-716** A preset is a saved map layout: the circles, their members and the shares, with a name. Apply a preset from the History view or with `kitshn_preset`. An apply is one revision with Undo, runs the guard of K-105, and follows K-715 for agents.

## 8. Recipes and deploys

- **K-801** A recipe is `kitshn.config.ts` with `export default defineApp({...})`. The value is one object literal. The `kitshn` npm package exports `defineApp` and its types.
- **K-802** Recipes do not compute. A lint rule in `kitshn check` refuses loops, conditions, function calls other than `defineApp`, and imports other than `kitshn`. The lint rule is enough, because kitshn never runs repo code (K-803).
- **K-803** GitHub Actions evaluates the recipe and sends JSON. kitshn checks the JSON with the same schema. kitshn never runs repo code.
- **K-804** Kinds: a Compose app (`compose`), a static site (`static`), a Worker app (`worker`). A recipe has exactly one kind.

  ```ts
  import { defineApp } from "kitshn";

  export default defineApp({
    compose: { runsOn: ["docker", "server"], expose: { web: "riffle" } },
    needs: { vars: ["RIFFLE_BASE_URL"], secrets: ["DATABASE_URL"] },
    deploy: [
      { on: "push", branch: "main", name: "prod", address: "riffle.example.com" },
      { on: "pull_request", name: "pr-{pr}", ephemeral: true, startsIn: "Owner" },
    ],
  });
  ```

- **K-805** A static site names a build command and an output folder. Actions builds it and uploads the files. kitshn deploys them as Workers static assets, with no Worker code, so their requests are free ([static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)).
- **K-806** A Worker app names its `wrangler.jsonc`. kitshn refuses fields that name a place: `account_id`, `name`, `routes`, `env`, and fixed storage ids. kitshn sets the name, the routes and the storage for each environment.
- **K-807** `deploy` maps triggers to environments as in KitSHn 1: the first matching entry wins. `startsIn` names the circle of a new environment. After that, the map decides (K-518).
- **K-808** `needs.vars` and `needs.secrets` list names. Values come from the kitshn store, per app and environment. A `KITSHN_<NAME>` GitHub variable or secret forwards into the store as `<NAME>` on each deploy and wins over the store. A deploy fails before any work when a needed name has no value, and it names each missing name.
- **K-809** The kitshn store encrypts secret values with AES-GCM under a Worker secret. The map shows names and "set" or "missing", never a value.
- **K-810** The workflow file is the same few lines for every app. It needs `permissions: id-token: write` and calls the kitshn action.
- **K-811** Deploy auth: Actions sends its GitHub OIDC token (issuer `https://token.actions.githubusercontent.com`). kitshn accepts a token whose `repository_owner_id` is on its list of owners. It refuses any other token. The list holds user accounts only; GitHub organizations are not on it for now.
- **K-812** A Compose deploy is a job (K-610). Actions uploads the source as a `git archive` to R2 through a short-lived signed URL. The daemon downloads it, builds with Compose at the lowest CPU weight (as KitSHn 1), and starts it. The archive is deleted after the job.
- **K-813** The Actions step keeps one WebSocket to kitshn until the deploy ends, and prints each log line and the final address. It fails when the deploy fails.
- **K-814** The deploy ends with a route check: kitshn requests the address and records status and content type, as KitSHn 1 does.
- **K-815** `kitshn try` builds and runs a recipe on the machine of the developer with a temporary socket, as KitSHn 1 `try`. It touches no environment.
- **K-816** kitshn creates a GitHub deployment and its status for each environment, with the address.

## 9. Previews

- **K-901** A pull request environment gets an address one level deep, so the free Universal SSL certificate covers it: `<app>-pr-<n>.<zone>`. [Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/) covers the apex and one level of subdomain.
- **K-902** A preview of a Compose app runs on the machine of its app. It gets a tunnel route to its socket and a DNS record.
- **K-903** A preview of a static site or Worker app is its own Worker script with a custom domain. The free plan allows 100 Worker scripts per account; kitshn refuses a new preview at 90 and names the open previews.
- **K-904** With the GitHub App (K-908), a closed pull request removes its preview at once: containers, images, volumes, socket, route, DNS record, Access application and card. Without the App, the workflow does it on the `closed` event, as KitSHn 1.
- **K-905** A preview keeps what the recipe lists in `keep` (logs, data folders), as KitSHn 1. "Prune" in the card panel removes what is kept.
- **K-906** Preview limits work as KitSHn 1: `limits: { cpus, memory }` caps all previews of an app together. Production is never limited.
- **K-907** A preview starts in its `startsIn` circle, by default "Owner".
- **K-908** The kitshn GitHub App adds: preview teardown on close (K-904), deployment statuses (K-816) without a workflow token, repo cards before the first deploy, and "New app" from the map, which creates a repo from a template. The owner creates the App after the spec is approved.

## 10. Artifacts library

- **K-1001** Every HTML page from T3 threads on every machine goes into one library in R2. The provider sends each new `html_render` page with `publishPage` (K-708), with its thread title, machine and time.
- **K-1002** A new page is private: it sits in the tray (K-509).
- **K-1003** The Worker serves a page at `pages.<zone>/<id>`, with the sandbox of the T3 render route (no same-origin scripts). The id is random, 16 characters or more.
- **K-1004** The Worker checks shares for each page request (K-404). A page in "Everyone" opens with no login. Other pages need a login through an Access application on `pages.<zone>/login`, which sends the visitor back. VERIFY: the Worker can read the Access JWT cookie that the login path sets, on the other paths of the same host.
- **K-1005** The Library view lists all pages with a search by title, thread and machine, and a preview. It reads the index in the Durable Object, not R2.
- **K-1006** Deleting a thread does not delete its library page. "Delete" in the library removes the page from R2 and the map.
- **K-1007** An MCP App page is not shared, because its buttons need its live MCP server. The library keeps it private and says why.
- **K-1008** An import adds all past pages of each machine once. Each imported page is private, as a new page (K-1002). Work pages (QCDI, Upsolver, SDE) are no exception. On 2026-10-27 there are 46 pages, about 14 MB: 41 on the Mac, 5 on the VPS, 0 on the Oracle VPS. Pages on Windows are not counted, and wait for the Windows daemon (K-601). New pages arrive at about 20 per week.

## 11. Files and sites

- **K-1101** "Upload" on the map, and `kitshn_publish` for agents, put a file into R2 and a card into the tray. A file is at most 100 MB.
- **K-1102** The Worker serves files at `files.<zone>/<id>/<name>` with the checks of K-1004.
- **K-1103** Public sites (for example tick3d and the resume) are static sites (K-805) in the Everyone circle.
- **K-1104** A live site is a local server of a machine, shared through the tunnel of the machine. `kitshn expose <socket or port> --name <name>` or `kitshn_expose` adds it. Its address is `<name>.<zone>`. It is live only: when the machine is off, the site is off. kitshn keeps no copy.
- **K-1105** A live site of a dev server gets the `Host` header `localhost` toward its origin, because Vite and similar servers refuse other hosts.
- **K-1106** When the origin of a live site or of a Compose app is down, visitors who pass Access get the kitshn offline page:
  - It uses the kitshn look (K-517), a short playful message, the site name, the machine name, the time the site was last seen, and "It comes back when <machine> is on."
  - It has one button, "Knock again", which loads the address again. It has no continuous animation and no automatic reload.
  - The response is status 503 with `Retry-After: 60` and `Cache-Control: no-store`.
  - The Worker serves it from its own static assets, with no call to the machine.
- **K-1107** kitshn detects a down origin in two ways, and acts on either:
  - The machine is off: its daemon socket closes, or misses pings for 30 seconds.
  - The machine is on, but the local server is off: the daemon tries the socket or port of each exposed site every 10 seconds, on the machine only, and reports a change.
- **K-1108** While an origin is down, kitshn adds a Worker route for the site address to the kitshn Worker. When the origin is back, it removes the route. So visits to a healthy site never run the Worker and cost no Worker request. Custom error rules would do this with no Worker, but the free plan has none ([Custom Errors](https://developers.cloudflare.com/rules/custom-errors/)).
- **K-1109** While the route exists, the Worker first passes the request to the origin. It shows the offline page only when the answer is status 502 or 530, or a Cloudflare 1033 error. So a site that comes back before kitshn removes the route works at once. VERIFY: a fetch from a Worker on a route to the same hostname reaches the origin and does not run the Worker again.
- **K-1110** The Worker reads the site name and the last seen time from the Durable Object, and keeps them for 60 seconds in the Cache API.
- **K-1111** Domains: kitshn publishes only on zones that the owner adds to it. Each address must be in one of them.

## 12. Bootstrap

- **K-1201** One command sets up kitshn on a new Cloudflare account: `curl -fsSL https://kit.yarden-zamir.com/install | sh`, with the Cloudflare API token in `CLOUDFLARE_API_TOKEN`. The `/install` path needs no login.
- **K-1202** The owner makes the token by hand through a link with the permissions filled in. The script names each missing permission and the link.
- **K-1203** The script uses only `curl`, `sh` and `jq`. It downloads the Worker bundle of a kitshn release and uploads it through the Workers API, with static assets through the direct upload flow ([direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)). It does not use Wrangler.
- **K-1204** The script creates, or reuses when present: the Worker with its Durable Object, the R2 bucket, the Worker secrets, the Access applications of the admin resource and of `/connect`, the Owner circle policy with the owner email and "needs passkey", the One-time PIN login method, the GitHub login method (K-102), and seat expiration (K-111).
- **K-1205** A second run changes nothing that is already right. It prints what it changed.
- **K-1206** At the end, the script prints the admin address and a one-time link to register the first passkey in the Access App Launcher.
- **K-1207** The Zero Trust organization (the team domain and the free plan) exists on the owner's account. On a new account, the script tests whether the API can create it. When it cannot, the script stops with the dashboard link, and continues on the next run after one dashboard visit. VERIFY: an API that creates the Zero Trust organization.
- **K-1208** The admin and the map live at `kit.yarden-zamir.com`. The KitSHn 1 website moves from `kitshn.yarden-zamir.com` to `kitshn-legacy.yarden-zamir.com`. KitSHn 1 serves it from the `kitshn-meta` repo.

## 13. Free plan budget

- **K-1301** The reference setup is 5 machines, about 15 apps, about 50 pages that grow by about 20 per week (K-1008), 2 people and a few guests. [docs/architecture.md](docs/architecture.md) holds its budget table.
- **K-1302** kitshn writes Durable Object rows only on change. Presence writes on change only. Resource samples are not stored in the Durable Object (K-606). Each `setAlarm` counts as one row written ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)), so kitshn sets one alarm for the next due item, never one alarm per item.
- **K-1303** The admin view shows today's use of Worker requests, Durable Object requests, rows written, Access seats, Access applications, service tokens, Worker scripts and DNS records, with a warning at 80% of each limit. The token has "Account Analytics: Read" for this view.
- **K-1304** When a daily Durable Object limit runs out, the map shows the cause and the reset time (00:00 UTC). Cloudflare Access keeps enforcing the last compiled shares, so access does not change.

## 14. Migration

- **K-1401** The machine map portal and KitSHn 1 keep running until each piece moves. [docs/migration.md](docs/migration.md) holds the order.
- **K-1402** `.github/workflows/deploy.yml` in this repo forwards to KitSHn 1 and stays until the last app moves. `.github/workflows/host.yml` stays until no app needs the host Caddy.
- **K-1403** An import reads a machine map export and creates: a machine card for each machine, keeping its tunnel, its hostname and its service token; a circle for each arrow source, with the machine as member; Guests rules as circles; shared settings as `t3.settings` desired state. It does not import history, browser keys or presets.
- **K-1404** A KitSHn 1 app moves with `kitshn adopt owner/repo`: it writes `kitshn.config.ts` from `.kitshn.yaml`, `compose.yml` and `Caddyfile.j2`, and changes the workflow file. The first deploy with kitshn 2 reuses the persistent data folder of KitSHn 1 on the same machine, then the DNS record moves from the VPS address to the tunnel.

## 15. History and safety

- **K-1501** Every change makes one revision with the time, the actor (owner device, agent with machine and thread, or kitshn for an expiry) and a summary.
- **K-1502** "Undo" on a revision makes a new revision that reverses it. Undo runs the guard of K-105.
- **K-1503** Revisions older than 90 days and beyond the newest 5,000 are deleted by the daily alarm.
- **K-1504** "Emergency pause" moves no card, but sets every share to none except the admin share of the Owner circle, and sends "stop all agents" to every provider that has the command. "Resume" returns the shares. The pause keeps MM-708 to MM-719 where they apply.
