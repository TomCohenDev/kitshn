import { join } from "node:path";

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
