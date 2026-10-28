# KitSHn 2 architecture

This page says what the parts are, where each piece of state lives, how requests travel, and what the free plan budget is. The numbered requirements are in [SPEC.md](../SPEC.md).

## Parts

| Part | Where it runs | What it does |
| --- | --- | --- |
| kitshn Worker | Cloudflare | Routes requests, checks Access JWTs and GitHub OIDC tokens, serves pages, files and the offline page. Its static assets hold the map UI. |
| kitshn Durable Object | Cloudflare, one instance | Holds all state in SQLite. Keeps the daemon sockets and the map sockets. Runs the alarm queue that writes Cloudflare API changes. |
| R2 bucket | Cloudflare | Library pages, files, and deploy archives while a deploy runs. |
| Cloudflare Access | Cloudflare | Logs people in and checks circles at the edge for every address that has an Access application. |
| Tunnels | Cloudflare and each machine | One remotely managed tunnel per machine. Ingress goes to Unix sockets on the machine. |
| App Workers | Cloudflare | One Worker script per environment of a static site or Worker app. |
| `kitshn` daemon | Each machine | Runs `cloudflared`, runs jobs (Compose deploys, commands), checks local sites, keeps sample history, serves the local socket for providers. |
| Providers | Each machine | Programs such as T3 Code that add resource kinds through the local socket. |
| `kitshn` npm package | App repos and Actions | `defineApp`, the recipe types, and the GitHub Action that evaluates the recipe and sends JSON. |
| GitHub App | GitHub | Webhooks for pull request close, deployment statuses, repo discovery, "New app". |

```text
 people, devices ──► Cloudflare edge ──► Access (circles as policies)
                         │                   │
          ┌──────────────┼───────────────────┼──────────────────────┐
          ▼              ▼                   ▼                      ▼
   kitshn Worker    App Workers         tunnel of a machine    pages/files (Worker)
    + static UI     (static assets)          │
          │                                  ▼
   Durable Object ◄── WebSocket ──── kitshn daemon ── unix sockets ──► Compose apps, live sites
   (SQLite, alarms)                         │
          │                          local socket (JSON lines)
          ▼                                  ▼
     Cloudflare API                      T3 Code (provider)
```

## Where state lives

| State | Lives in | Notes |
| --- | --- | --- |
| Circles, members, shares, overrides, card places, stacks, presets | Durable Object SQLite | Never in Git (K-518, K-716). |
| Resource index (machines, apps, environments, pages, files) | Durable Object SQLite | R2 holds the bytes. |
| Revisions (history) | Durable Object SQLite | Pruned after 90 days or 5,000 entries (K-1503). |
| Job queue and command results | Durable Object SQLite | Expired jobs pruned daily. |
| App vars and secrets | Durable Object SQLite, secrets encrypted | Key in a Worker secret (K-809). `KITSHN_*` GitHub values win on deploy. |
| Presence and latest sample | Durable Object memory, presence also in SQLite on change | Samples never written (K-606). Presence keeps the system of the last status (K-524). |
| Card icons of static sites | Durable Object SQLite, at most 100 KB each | Written only when the bytes change (K-1113). Not R2, so icons work without R2 and need no second check. |
| Sample history | Daemon disk | 30 days. |
| Access applications and policies | Cloudflare Access | Compiled from shares. kitshn is the source; Access is the copy. |
| Tunnel ingress, DNS records, Worker routes | Cloudflare | Compiled from resources. |
| Machine token, tunnel token | Daemon file, mode 0600 | Never in the Durable Object at rest. During a join, encrypted like MM-1201. |
| Machine key pair (planned, K-1702) | Private half in a daemon file, mode 0600; public half in Durable Object SQLite | |
| Pass signing key (planned, K-1711) | Worker secret; public halves of retired keys in Durable Object SQLite for 6 minutes | |
| Used pass ids (planned, K-1715) | Durable Object SQLite | Deleted by the daily alarm after expiry. |
| Recipe | App repo | The only state in Git. |
| Page and file bytes | R2 | |
| Compose data, logs | Machine disk | Same layout ideas as KitSHn 1. |
| Device view (zoom, pan) | Browser local storage | |

## Request paths

1. **The owner opens the map.** Access checks the admin application (email code and passkey). The Worker serves the UI from static assets. The page opens one WebSocket to the Durable Object and gets a snapshot, then changes.
2. **The owner drops a card into a circle.** The page sends the change. The Durable Object writes the share and a revision, pushes the change to open pages and to affected daemons, and adds an Access job to the alarm queue. The alarm writes the Access change in runs of at most 40 API calls.
3. **A visitor opens a Compose app.** Access checks the circles of its application. The tunnel sends the request to the machine, and `cloudflared` sends it to the Unix socket of the service. The Worker is not on this path.
4. **A visitor opens a live site whose machine is off.** The Durable Object saw the daemon socket close and added a Worker route for that address. Access checks the visitor. The Worker tries the origin, gets 530 or error 1033, and answers with the offline page from its assets. When the daemon connects again, the route goes away.
5. **A visitor opens a page.** Public page: the Worker serves it from R2. Other page: the Worker reads the Access JWT. Without one, it sends the visitor to `/login`, an Access application, which sends the visitor back. Then the Worker checks the circles and serves the page.
6. **An app deploys.** Actions evaluates `kitshn.config.ts` and sends JSON with its OIDC token. The Worker checks the token and the schema. For a Compose app, the Durable Object picks a machine (K-610), gives Actions a signed R2 upload URL for the source archive, and sends the job to the daemon. The daemon builds and starts the app and streams logs; the Actions step prints them over one WebSocket. For a static site or Worker app, Actions uploads the files, and the Worker uploads the script through the Workers API.
7. **T3 Code asks for a level.** T3 Code reads the Access JWT on its request and checks the grant table that the daemon pushed (K-706). There is no network call.
8. **A pull request closes.** The GitHub App webhook reaches the Worker. The Durable Object queues a teardown job for the machine and the Cloudflare clean-up for the alarm.
9. **An agent key adds an app (K-718, K-819).** The owner turns on "may add apps" and, for a public app, "may publish" for the key in its agent circle. The agent creates the repo and pushes. The first deploy step records the repo and waits. `GET kit.<zone>/agent/state` lists the waiting repos with `repoId`. The agent sends `{"state": "allowed"}` to `POST kit.<zone>/agent/repos/<repoId>`, which starts the waiting branch. The card starts in the agent circle, and a Compose app runs only on a machine that the key manages. To publish, the agent sends `{"card": <id>, "public": true}` to `POST kit.<zone>/agent/publish`. Each call carries the key's `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.
10. **An agent on a machine acts (planned, section 17).** The agent asks its daemon on the local socket for a pass for one action. The daemon checks that the agent runs as an allowed local user (K-701) and asks kitshn over its signed connection. With "automatic", kitshn answers with a pass, and the agent sends it to `kit.<zone>/agent/<action>`; the Worker checks the pass, and the Durable Object checks the `jti` and the machine's rights again. With "ask me", kitshn makes an Inbox proposal and sends a push; an approve with a fresh passkey runs the action, and the daemon gives the result to the agent.

## Free plan budget

Reference setup (K-1301): 5 machines, about 15 apps with about 5 open previews, about 50 pages that grow by about 20 per week, 2 people and a few guests. The numbers are estimates from the request paths above, not measurements.

| Budget | Free limit | Expected use | How it stays low |
| --- | --- | --- | --- |
| Worker requests | 100,000 per day ([limits](https://developers.cloudflare.com/workers/platform/limits/)) | about 500 per day for kitshn: 60 map, 80 deploys, 60 webhooks, 150 pages and files, 50 offline page, 25 daemon reconnects, rest misc. Section 17 adds about 350: 300 agent pass uses and at most 50 discovery and JWKS fetches (K-1740). App Workers share the same budget. | Access and tunnels carry app traffic. Static assets are free. The offline route exists only while an origin is down. |
| Worker CPU | 10 ms per request | under 5 ms for a snapshot of about 500 rows | Waiting on the Cloudflare API does not count. |
| Subrequests | 50 per request | at most 40 per alarm run | Alarm queue (K-406). |
| Durable Object requests | 100,000 per day ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)) | about 4,200 per day, with about 320 for agent passes (K-1740): 500 from the Worker, about 450 from 8,700 daemon messages at the 20:1 WebSocket ratio, 2,880 alarms for the 30-second liveness check of K-1107 while a daemon is connected, 100 other alarms | Pings use the auto response. Samples once a minute. A pending alarm never moves later. |
| Rows written | 100,000 per day | about 4,200 per day, counting index rows: shares and revisions 200, deploys 160, pages 10 (about 3 new pages a day), presence 100, alarms 100, Access bookkeeping 100, and from milestones 5 and 6 about 600 more: cross-machine audit events 300 (K-1610), applied-revision reports 100 (K-1608), alert events 50 (K-1604), proposals and push subscriptions 50, doubled for indexes, plus 2,880 `setAlarm` writes for the liveness check; section 17 adds about 650: 600 for used pass ids (one write and one delete each) and 50 for proposals and key changes (K-1740) | Write on change only. One alarm for the next due item. No sample rows; status and samples live on the daemon socket. |
| Rows read | 5,000,000 per day | about 30,000 per day | Snapshot per map open. |
| DO storage | 5 GB | under 50 MB | Bytes live in R2. |
| R2 storage | 10 GB-month ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)) | about 14 MB of pages today (46 pages), growing about 6 MB per week, so about 300 MB after one year. Files as uploaded, at most 100 MB each (K-1101), archives deleted after each deploy | |
| R2 Class A | 1,000,000 per month | about 3,000 per month | |
| Access seats | 50 people | about 7: owner, one second user, a few guests | Seat expiration after 1 month (K-111). Devices and machines use service tokens, which take no seat. |
| Access applications | 500 ([account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)) | about 40 | Public resources need none. |
| Reusable policies | 500 | about 10, one per circle | |
| Service tokens | 50 | about 9: 5 machines, 4 devices | GitHub uses OIDC, no token. |
| Tunnels | 1,000 | 5 | |
| Worker scripts | 100 | about 15: kitshn, 8 app environments, 5 previews | Refuse new previews at 90 (K-903). |
| DNS records per zone | 200 for Free zones made after 2024-09-01, 1,000 before ([DNS FAQ](https://developers.cloudflare.com/dns/faq/)) | about 35 | One record per address. The owner's zone `yarden-zamir.com` was made on 2026-09-29, so its limit is 200. It had 70 records on 2026-10-27. |
| Rate limiting rules | 1 on Free | 1, kept from the guest links rule | |

The tightest limits for growth are service tokens (50) and Worker scripts (100), not requests.

## Choices and simpler options

- **Schema migrations.** The Durable Object keeps a `schema_version` in its `meta` table and runs numbered migrations from `packages/edge/src/worker/migrations.ts` once, in order. A shipped migration never changes; a new one goes at the end.

- 🟠 **One Durable Object for everything.** It is simple and fits the budget. One instance serializes all writes, which is fine at this size. Revisit when the map holds more than about 10,000 cards.
- 🟠 **Samples on the machine, not in the Durable Object.** The machine map wrote one row per machine per minute. That alone is about 7,200 rows written per day for 5 machines. Revisit if history must work while a machine is offline.
- 🟠 **Source archive through R2, not a git clone on the machine.** The machine needs no GitHub credential. The GitHub App could hand out clone tokens instead; revisit when archives pass 500 MB.
- 🟠 **Offline page through a temporary Worker route.** Custom error rules would need no Worker, but they need a paid plan. A Worker route on every live site would cost a request for each file of a dev server page.
- 🟠 **No Caddy.** `cloudflared` reaches Unix sockets directly. An app that needs rewrites keeps its own Caddy inside its Compose file.
