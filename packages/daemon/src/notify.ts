/**
 * K-1908: every service of a Compose app gets `KITSHN_NOTIFY_URL` and `KITSHN_NOTIFY_TOKEN`, so the app needs no
 * Compose change; a value that the app sets itself wins. No file holds the token: the key goes in as null, and each
 * place where Compose interpolated the token (another key, a command, a label, a build arg) becomes
 * `${KITSHN_NOTIFY_TOKEN}` again, which Compose fills in from its own environment at `up`.
 */
export function withNotify(
  config: unknown,
  notify: { readonly url: string; readonly token: string } | undefined,
): unknown {
  if (notify === undefined) return config;
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
        const environment = { ...(own as Record<string, string | null> | undefined) };
        if (!("KITSHN_NOTIFY_URL" in environment)) environment["KITSHN_NOTIFY_URL"] = notify.url;
        if (!("KITSHN_NOTIFY_TOKEN" in environment)) environment["KITSHN_NOTIFY_TOKEN"] = null;
        return [name, { ...service, environment }];
      }),
    ),
  };
  // `config --format json` writes a literal `$` as `$$`, so only this text is interpolated again at `up`.
  return JSON.parse(JSON.stringify(added).replaceAll(notify.token, "${KITSHN_NOTIFY_TOKEN}")) as unknown;
}
