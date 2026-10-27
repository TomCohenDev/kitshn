# KitSHn 2 migration plan

The machine map portal (in the T3 Code fork, `apps/machine-map`) and KitSHn 1 (`Yarden-zamir/kitshn-1`) keep running until each piece moves (K-1401). Each milestone ends in a state where everything works.

| # | Milestone | What ships | What keeps working |
| --- | --- | --- | --- |
| 0 | Spec approved | This spec. The GitHub App is created. | Everything as today. |
| 1 | Edge core | Worker, Durable Object, R2, bootstrap script (section 12), admin resource, Owner circle with passkey, map with circles and shares, history. Test: `unix:` ingress on a remotely managed tunnel (K-607), reusable policies on many apps (K-402). | Portal and KitSHn 1 unchanged. kitshn runs on its own address and manages nothing live yet. |
| 2 | Daemon and machines | `kitshn` daemon, join, tunnel, status, jobs, commands, labels and order. Join one test machine first. | Portal keeps the T3 machines. The test machine has no T3 tunnel. |
| 3 | Static sites, pages and files | Static site and Worker app deploys, library, uploads, the offline page. Move tick3d and the resume first. | KitSHn 1 apps unchanged. T3 pages stay in threads; the import copies them. |
| 4 | Compose deploys and previews | Compose jobs on sockets, previews, GitHub App teardown, `kitshn adopt`. Move one app (for example `kitshn-meta`), then the rest one at a time. | `deploy.yml` in this repo still forwards to KitSHn 1 for apps that did not move. `host.yml` keeps the host Caddy for them. |
| 5 | T3 interface | `@kitshn/local`, T3 fork provider files and hooks, `kitshn_*` tools, grant tables, settings as desired state. | T3 machines still use the portal. The provider stays off by a server setting until milestone 6. |
| 6 | Portal cutover | Import the machine map (K-1403), keeping tunnels, hostnames and service tokens. Turn the provider on one machine at a time. Guest links move to `t3.thread` circles. | Portal stays read-only for one week, then its Worker is removed. |
| 7 | Clean-up | Remove `deploy.yml` forwarding and `host.yml` once no app calls them. Remove Caddy from the VPS. Remove `apps/machine-map` from the fork. Remove the KitSHn 1 Python code from this repo. | Nothing calls the removed parts. |

## Risks to watch

- 🔴 `release.yml` and `homebrew.yml` still run on this repo's `main`. A merge here that bumps `pyproject.toml` publishes a KitSHn 1 release from this repo and points the Homebrew formula back at `Yarden-zamir/kitshn`, which overwrites the formula of kitshn-1. Proposal: delete both workflows from this repo in milestone 1, or earlier. This draft does not change them.
- Each moved app changes one line in its own workflow file: `permissions: id-token: write`. A reusable workflow cannot raise the permissions of its caller, so `deploy.yml` here cannot do it for the apps.
- The address: the admin of kitshn 2 needs a host. `kitshn.yarden-zamir.com` serves the KitSHn 1 website today. The host is open: see K-1208 in the spec.
- During milestone 4, one VPS serves both KitSHn 1 apps (Caddy on ports 80 and 443) and kitshn 2 apps (tunnel). They do not clash, because kitshn 2 needs no inbound port. A moved app changes its DNS record from the VPS address to the tunnel, so the move has a short window of DNS caching.
