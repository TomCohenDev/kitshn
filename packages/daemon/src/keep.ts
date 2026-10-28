// K-821: the builds of a Compose app that the daemon keeps for a rollback, and their image tags.

/** The tag that keeps the image of one service of one deploy, so a rollback needs no build and no registry. */
export const keptTag = (project: string, service: string, deployId: string) =>
  `kitshn-keep/${project}/${service.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}:${deployId}`;

/**
 * The image that Compose runs for each service of a checked config: its `image`, or `<project>-<service>` for a
 * service that Compose builds. A rollback tags each kept image with this name, so `up --no-build` runs it.
 */
export function serviceImages(config: unknown, project: string): Map<string, string> {
  const services = (config as { services?: Record<string, { image?: unknown }> } | null)?.services ?? {};
  return new Map(
    Object.entries(services).map(([name, service]) => [
      name,
      typeof service?.image === "string" && service.image !== "" ? service.image : `${project}-${name}`,
    ]),
  );
}

/**
 * The kept tags that go after a new build of the app came up: every tag of the app whose deploy is neither the new
 * build nor the one before it. A preview keeps no build before its last one.
 */
export function staleTags(
  tags: ReadonlyArray<string>,
  project: string,
  keep: ReadonlyArray<string>,
): Array<string> {
  const prefix = `kitshn-keep/${project}/`;
  return tags.filter((tag) => tag.startsWith(prefix) && !keep.some((id) => tag.endsWith(`:${id}`)));
}
