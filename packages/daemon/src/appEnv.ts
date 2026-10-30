import type { AppAccess } from "@kitshn/edge/machine";

export type Notify = { readonly url: string; readonly token: string };

/** K-822: the Access values of an app, as the variables that it gets. */
export function accessEnv(access: AppAccess): Record<string, string> {
  return {
    KITSHN_ACCESS_TEAM_DOMAIN: access.teamDomain,
    KITSHN_ACCESS_AUDIENCES: access.audiences.join(","),
  };
}

/**
 * K-1908, K-822: every service of a Compose app gets the kitshn variables of the job, so the app needs no Compose
 * change; a value that the app sets itself wins. No file holds the notify token: the key goes in as null, and each
 * place where Compose interpolated the token (another key, a command, a label, a build arg) becomes
 * `${KITSHN_NOTIFY_TOKEN}` again, which Compose fills in from its own environment at `up`.
 */
export function withAppEnv(
  config: unknown,
  job: { readonly notify?: Notify | undefined; readonly access?: AppAccess | undefined },
): unknown {
  const values: Record<string, string | null> = {
    ...(job.notify ? { KITSHN_NOTIFY_URL: job.notify.url, KITSHN_NOTIFY_TOKEN: null } : {}),
    ...(job.access ? accessEnv(job.access) : {}),
  };
  if (Object.keys(values).length === 0) return config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return config;
  const services = (config as { services?: unknown }).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return config;
  const added = {
    ...config,
    services: Object.fromEntries(
      Object.entries(services as Record<string, Record<string, unknown>>).map(([name, service]) => {
        const own = service["environment"];
        // `docker compose config --format json` gives the environment as a map; anything else is unexpected.
        if (own !== undefined && (typeof own !== "object" || own === null || Array.isArray(own)))
          throw new Error(`the environment of the service ${name} is not a map (K-1908)`);
        return [name, { ...service, environment: { ...values, ...(own as Record<string, string | null>) } }];
      }),
    ),
  };
  if (!job.notify) return added;
  // `config --format json` writes a literal `$` as `$$`, so only this text is interpolated again at `up`.
  return JSON.parse(JSON.stringify(added).replaceAll(job.notify.token, "${KITSHN_NOTIFY_TOKEN}")) as unknown;
}
