// K-821: the builds of a Compose app that the daemon keeps for a rollback, and their image tags.
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

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

/**
 * A Compose override that runs each service from its kept tag and never pulls. A rollback so changes no image name
 * that another app may run (such as `redis:7`), and `pull_policy: always` in the app cannot pull a newer image.
 */
export function rollbackOverride(config: unknown, project: string, deployId: string) {
  return {
    services: Object.fromEntries(
      [...serviceImages(config, project).keys()].map((service) => [
        service,
        { image: keptTag(project, service, deployId), pull_policy: "never" },
      ]),
    ),
  };
}

/** The deploy that a kept build folder (`good/` or `good.prev/`) holds, or null. */
export const keptId = (set: string) =>
  existsSync(join(set, "deploy-id")) ? readFileSync(join(set, "deploy-id"), "utf8").trim() : null;

/**
 * Makes the staged build the last good one (`good/`). A new build or a rollback moves the build that ran so far to
 * `good.prev/`, for the next rollback; a redeploy starts `good/` again and keeps `good.prev/`; a preview keeps one build.
 * A stop in the middle leaves `good.old/`, which the next job takes as `good/`.
 */
export function keepBuild(dir: string, staged: string, redeploy: boolean, preview: boolean) {
  const good = join(dir, "good");
  const previous = join(dir, "good.prev");
  rmSync(`${good}.old`, { recursive: true, force: true });
  if (redeploy) {
    if (existsSync(good)) renameSync(good, `${good}.old`);
  } else {
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(good)) renameSync(good, preview ? `${good}.old` : previous);
  }
  renameSync(staged, good);
  rmSync(`${good}.old`, { recursive: true, force: true });
}
