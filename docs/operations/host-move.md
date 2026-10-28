# Host move: `kit.<zone>` to `kitshn.<zone>` (K-1209)

The move has no redirect. Everything that names the old host changes to the new one. Run it after the section 17 pull request deploys: that release takes the old host and the audience tags of both hosts while `KITSHN_OLD_HOST` is set.

Passkeys survive the move, because they belong to the Access team domain (K-113). During the move, the count of Access applications doubles (K-1303).

## Before

1. Merge and deploy the section 17 pull request.
2. Stop the KitSHn 1 redirect of `kitshn.<zone>` to `kitshn-legacy.<zone>`: remove it from the `kitshn-meta` Caddyfile and remove its DNS record.
3. Check that `https://kitshn.<zone>` no longer answers.

## Move

1. Run the bootstrap with `KITSHN_HOST=kitshn.<zone>` and `KITSHN_OLD_HOST=kit.<zone>`. It makes the Access applications of the new host and the Worker binding `KITSHN_OLD_HOST`, and each `ACCESS_*_AUD` lists the tags of both hosts. Later bootstrap runs keep the old host until step 1 of "After".
2. Worker: add the custom domain `kitshn.<zone>`.
3. Daemons: on each joined machine, change the server address in `machine.json` and restart the daemon. Check that each card shows a signed connection.
4. GitHub App: change the homepage, callback and webhook addresses.
5. Text and config in this repo: `.github/workflows/kitshn2-deploy.yml` (its default `server`, which app repos call with `@main`), `packages/edge/public/install`, `site/apps.js`, `site/index.html`, `site/install/index.html`, `packages/kitshn/skill/SKILL.md`, `AGENTS.md`, `docs/`, and every `kit.<zone>` in `SPEC.md`.
6. App repos: run `gh search code "kit.yarden-zamir.com" --owner Yarden-zamir` and change each hit, also README badges. The search sees only default branches, so open branches that name `kit.` break after the move.
7. T3 fork docs: run the same search on `Yarden-zamir/t3code`.

## Checks

1. Each daemon is connected with its key.
2. A push deploys an app end to end.
3. A login with a passkey works, and so does the fresh check of `/api/fresh`.
4. `/public/cards.json` and a badge answer.
5. The install script works from `https://kitshn.<zone>/install`.

## After

1. Run the bootstrap with `KITSHN_OLD_HOST=none`. The Worker then takes only the new host and its audience tags.
2. Remove the `kit.` Access applications, the `kit.` custom domain and its DNS record.
3. Run the search of step 6 of the move again. It finds nothing.
4. Turn on "Passes" in Settings (17.7). Check that `/.well-known/openid-configuration` names `https://kitshn.<zone>` as its issuer.
