import type { ProjectVolume } from "@kitshn/edge/machine";

/** The format of `docker volume ls` that `idleVolumes` reads: the name and the Compose project. */
export const VOLUME_FORMAT = '{{.Name}}\t{{.Label "com.docker.compose.project"}}';
/** The format of `docker ps` that `idleVolumes` reads: the Compose project of each running container. */
export const RUNNING_FORMAT = '{{.Label "com.docker.compose.project"}}';

/**
 * K-909: the volumes of kitshn apps (a project with a folder under `apps/`) that no running container uses.
 * kitshn lists them as orphaned when the app has no card. The same list guards a volume delete.
 */
export function idleVolumes(
  volumeList: string,
  runningList: string,
  apps: ReadonlyArray<string>,
): Array<ProjectVolume> {
  const running = new Set(runningList.split("\n").map((line) => line.trim()));
  const known = new Set(apps);
  return volumeList.split("\n").flatMap((line) => {
    const [name = "", project = ""] = line.trim().split("\t");
    return name && known.has(project) && !running.has(project) ? [{ name, project }] : [];
  });
}

/** K-909: why the daemon refuses to delete a volume, or null when it is an idle volume of that kitshn app. */
export function volumeRemoveRefusal(
  idle: ReadonlyArray<ProjectVolume>,
  command: { readonly project: string; readonly volume: string },
): string | null {
  return idle.some((volume) => volume.name === command.volume && volume.project === command.project)
    ? null
    : `${command.volume} is no idle volume of the kitshn app ${command.project}; the daemon keeps it.`;
}
