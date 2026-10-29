/**
 * K-1908: every service of a Compose app gets `KITSHN_NOTIFY_URL` and `KITSHN_NOTIFY_TOKEN`, so the app needs no
 * Compose change. The token goes in as null, so Compose takes it from its own environment at `up`, and no file holds
 * it; the checked config stays with the last good build. A value that the app sets itself wins.
 */
export function withNotify(
  config: unknown,
  notify: { readonly url: string; readonly token: string } | undefined,
): unknown {
  if (notify === undefined) return config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return config;
  const services = (config as { services?: unknown }).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return config;
  return {
    ...config,
    services: Object.fromEntries(
      Object.entries(services as Record<string, Record<string, unknown>>).map(([name, service]) => {
        const own = service["environment"];
        // `docker compose config --format json` gives the environment as a map; anything else is unexpected.
        if (own !== undefined && (typeof own !== "object" || own === null || Array.isArray(own)))
          throw new Error(`the environment of the service ${name} is not a map (K-1908)`);
        const environment = { ...(own as Record<string, string | null> | undefined) };
        if (!("KITSHN_NOTIFY_URL" in environment)) environment["KITSHN_NOTIFY_URL"] = notify.url;
        // An explicit `${KITSHN_NOTIFY_TOKEN}` arrives interpolated, as the token itself; it goes out as null too.
        const token = environment["KITSHN_NOTIFY_TOKEN"];
        if (token === undefined || token === notify.token) environment["KITSHN_NOTIFY_TOKEN"] = null;
        return [name, { ...service, environment }];
      }),
    ),
  };
}
