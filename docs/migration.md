# KitSHn 2 migration plan

The machine map portal (in the T3 Code fork, `apps/machine-map`) and KitSHn 1 (`Yarden-zamir/kitshn-1`) keep running until each piece moves (K-1401). Each milestone ends in a state where everything works.

| # | Milestone | What ships | What keeps working |
| --- | --- | --- | --- |
| 0 | Spec approved | This spec. The GitHub App is created. | Everything as today. |
| 1 | Edge core | Worker, Durable Object, R2, bootstrap script (section 12), admin at `kit.yarden-zamir.com` (K-1208), admin resource, Owner circle with passkey, map with circles and shares, history. Test: `unix:` ingress on a remotely managed tunnel (K-607), reusable policies on many apps (K-402). | Portal and KitSHn 1 unchanged. kitshn runs on its own address and manages nothing live yet. The KitSHn 1 website moves to `kitshn-legacy.yarden-zamir.com`. |
| 2 | Daemon and machines | `kitshn` daemon, join, tunnel, status, jobs, commands, labels and order. Join one test machine first. The Seats view (K-112) and the usage view (K-1303). | Portal keeps the T3 machines. The test machine has no T3 tunnel. |
| 3 | Static sites, pages and files | Static site and Worker app deploys, library, uploads, the offline page. Move tick3d and the resume first. | KitSHn 1 apps unchanged. T3 pages stay in threads; the import copies them. |
| 4 | Compose deploys and previews | Compose jobs on sockets, previews, GitHub App teardown, `kitshn adopt`. Move one app (for example `kitshn-meta`), then the rest one at a time. | `deploy.yml` in this repo still forwards to KitSHn 1 for apps that did not move. `host.yml` in kitshn-1 keeps the host Caddy for them. |
| 5 | T3 interface | `@kitshn/local`, T3 fork provider files and hooks, `kitshn_*` tools, grant tables, settings as desired state. | T3 machines still use the portal. The provider stays off by a server setting until milestone 6. |
| 6 | Portal cutover | Import the machine map (K-1403), keeping tunnels, hostnames and service tokens. Turn the provider on one Mac or Linux machine at a time. Guest links move to `t3.thread` circles. | Windows machines stay on the portal (K-601). For Mac and Linux machines, the portal is read-only. |
| 7 | Clean-up | Remove `deploy.yml` forwarding once no app calls it, and kitshn-1's `host.yml` once no app needs the host Caddy. Remove Caddy from the VPS. Remove the KitSHn 1 Python code from this repo. | Nothing calls the removed parts. The portal stays for Windows machines. |
| 8 | Windows | The `kitshn` daemon as a Windows service. Move the Windows machines and import their pages (K-1008). Then remove the portal Worker and `apps/machine-map` from the fork. | Mac and Linux machines unchanged. |

## Risks to watch

- `release.yml` and `homebrew.yml` are in this repo, but both are disabled in GitHub (checked on 2026-10-27), so a merge here publishes no KitSHn 1 release. kitshn-1 has its own copies. Proposal: delete both files from this repo in milestone 7.
- Each moved app changes one line in its own workflow file: `permissions: id-token: write`. A reusable workflow cannot raise the permissions of its caller, so `deploy.yml` here cannot do it for the apps.
- The address: the admin of kitshn 2 is `kit.yarden-zamir.com` (K-1208). The KitSHn 1 website moves from `kitshn.yarden-zamir.com` to `kitshn-legacy.yarden-zamir.com`, served by KitSHn 1 from the `kitshn-meta` repo. Links to the old address, for example in the KitSHn 1 README, need an update.
- During milestone 4, one VPS serves both KitSHn 1 apps (Caddy on ports 80 and 443) and kitshn 2 apps (tunnel). They do not clash, because kitshn 2 needs no inbound port. A moved app changes its DNS record from the VPS address to the tunnel by hand. When the first kitshn 2 deploy takes over KitSHn 1 data (K-1404), it stops the KitSHn 1 app, so the site is down from that deploy until the record moves; move it right after the deploy.
