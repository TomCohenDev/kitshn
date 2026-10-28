import { dirname, join } from "node:path";

const PART = /^[A-Za-z0-9._-]+$/;

/**
 * K-1404: where KitSHn 1 kept the data of an app environment on this machine, and the Compose project it
 * ran as, by KitSHn 1's own rules (`Deployment.persistent_root`, `compose_project`). Null for a repo name
 * that KitSHn 1 could not have used, so no path leaves the persistent root.
 */
export function kitshn1Deployment(repo: string, environment: string, persistentRoot: string) {
  const [owner = "", name = "", ...rest] = repo.split("/");
  const parts = [owner, name, environment];
  if (rest.length > 0 || parts.some((part) => !PART.test(part) || part === "." || part === "..")) return null;
  const project = `${owner}-${name}-${environment}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return project ? { dataDir: join(persistentRoot, owner, name, environment), project } : null;
}

/** K-1404: what the first deploy of an app on this machine does with the data of its KitSHn 1 deployment. */
export type Takeover =
  | { readonly kind: "skip"; readonly note: string | null }
  | { readonly kind: "take"; readonly dataDir: string; readonly project: string };

export function takeoverPlan(input: {
  readonly repo: string;
  readonly environment: string;
  readonly persistentRoot: string;
  /** The app has a data folder on this machine already. */
  readonly hasData: boolean;
  /** An earlier deploy took the KitSHn 1 data over (the marker file). */
  readonly taken: boolean;
  readonly exists: (path: string) => boolean;
}): Takeover {
  if (input.hasData || input.taken) return { kind: "skip", note: null };
  const old = kitshn1Deployment(input.repo, input.environment, input.persistentRoot);
  if (!old) return { kind: "skip", note: null };
  // Preview data is throwaway: a pull request preview starts fresh, and its KitSHn 1 folder waits for its deletion.
  if (/^pr-\d+$/.test(input.environment))
    return {
      kind: "skip",
      note: input.exists(old.dataDir)
        ? `A preview takes no KitSHn 1 data; ${old.dataDir} stays for its deletion, and the app starts empty (K-1404).`
        : null,
    };
  // The note is for a renamed repo: KitSHn 1 knew the owner and app, but not this environment's folder.
  if (!input.exists(old.dataDir))
    return {
      kind: "skip",
      note: input.exists(dirname(old.dataDir))
        ? `No KitSHn 1 data at ${old.dataDir}; the app starts empty.`
        : null,
    };
  return { kind: "take", ...old };
}

/** The new name of a named volume of the KitSHn 1 project, or null when it is not one of its volumes. */
export function movedVolume(volume: string, oldProject: string, newProject: string): string | null {
  return volume.startsWith(`${oldProject}_`) ? `${newProject}_${volume.slice(oldProject.length + 1)}` : null;
}
