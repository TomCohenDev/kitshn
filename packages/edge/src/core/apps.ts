import { type LastDeploy, agentDeployPlan, isPreview } from "./agent.ts";
import type { AppCard } from "./changes.ts";
import type { Command, ProjectVolume } from "./machine.ts";
import type { State } from "./model.ts";

/**
 * K-909: what the removal of an app takes down itself. The tunnel route, the DNS record and the Access
 * application follow the card through the alarm sync, in the order of K-410.
 */
export type Teardown =
  | { readonly kind: "worker"; readonly address: string; readonly script: string }
  | {
      readonly kind: "compose";
      readonly machineId: string | null;
      readonly command: Extract<Command, { kind: "compose-down" }>;
    };

export function appTeardown(card: AppCard, zone: string): Teardown {
  const address = card.addresses[0];
  if (address === undefined) throw new Error(`The app ${card.name} has no address.`);
  // The Worker script of an environment is `kitshn-<card id>` (environmentNames in worker/deploys.ts).
  if (card.kind !== "site.compose") return { kind: "worker", address, script: `kitshn-${card.id}` };
  // K-909: a removal keeps the volumes and the last good build on the machine, so undo can start it again.
  const name = address.slice(0, -zone.length - 1);
  return {
    kind: "compose",
    machineId: card.machine,
    command: { kind: "compose-down", project: card.id, name, removeData: false },
  };
}

/** K-909: the newest `compose-down` job of a removal, as the jobs table holds it. */
export type DownJob = { readonly state: "queued" | "sent" | "done" | "failed" | "expired" } | null;

/**
 * K-909: the undo of a Compose removal waits while the machine runs its `compose-down`. Otherwise it cancels a
 * queued one and starts the app; the daemon runs a down that is still under way first (one job per app).
 */
export function composeUndo(down: DownJob): "refuse" | "start" {
  return down?.state === "sent" ? "refuse" : "start";
}

/** K-909: how the undo of a removal starts the app again, or why it does not. */
export type Restart =
  | { readonly kind: "redeploy"; readonly command: Extract<Command, { kind: "compose-redeploy" }> }
  | { readonly kind: "build"; readonly repo: string; readonly branch: string }
  | { readonly kind: "none"; readonly reason: string };

/**
 * K-909: a Compose app starts its last good build on its machine, and a static or Worker site builds again on
 * its branch. A static preview waits for the next push to its pull request; a preview whose pull request
 * closed does not come back. `refusal` is why kitshn starts nothing now, such as the pause or the repo gate.
 */
export function appRestart(
  last: LastDeploy | null,
  refusal: string | null,
  closed: boolean,
  machine: Parameters<typeof agentDeployPlan>[2],
): Restart {
  const none = (reason: string) => ({ kind: "none", reason }) as const;
  if (refusal !== null) return none(refusal);
  if (!last) return none("kitshn has no finished deploy of this app; the next deploy starts it.");
  if (isPreview(last.environment) && closed)
    return none(
      `The pull request of the preview ${last.environment} is closed, so the preview does not come back.`,
    );
  if (last.app === "static" && isPreview(last.environment))
    return none(`The preview ${last.environment} comes back on the next push to its pull request.`);
  const plan = agentDeployPlan(last, last.app === "compose" ? "redeploy" : "build", machine);
  return plan.kind === "refused" ? none(plan.error) : plan;
}

/** K-909: the idle volumes that a machine reports whose app has no card. */
export const orphanVolumes = (reported: ReadonlyArray<ProjectVolume>, state: State): Array<ProjectVolume> =>
  reported.filter((volume) => !state.resources.has(volume.project));
