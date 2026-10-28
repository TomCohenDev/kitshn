import type { Actor, Item, RevisionKind } from "./changes.ts";
import type { Command, Machine, MachineStatus, ProjectVolume, Sample } from "./machine.ts";
import type { MachineOs } from "./icons.ts";
import type { Circle, PauseMode, Point, Resource, ShareSetting, Stack } from "./model.ts";
import type { RepoGate } from "./repos.ts";

/** K-819: `resourceIds` are the cards that this repo deployed, which the card panel matches. */
export type RepoView = RepoGate & {
  readonly resourceIds: ReadonlyArray<string>;
  /** K-819: the agent key that allowed the repo is gone, so the repo waits; `state` then reads "waiting". */
  readonly keyRemoved: boolean;
};

export interface RevisionView {
  readonly id: number;
  readonly at: number;
  readonly actor: Actor;
  readonly summary: string;
  readonly undoes: number | null;
  readonly undoneBy: number | null;
  /** False for a revision that records an action, such as a shell command, and changes nothing. */
  readonly undoable: boolean;
  /** K-1508: for the History filters and the map highlight. */
  readonly kind: RevisionKind;
  readonly items: ReadonlyArray<Item>;
}

/** K-407: whether Cloudflare has the Access state of a card. */
export type AccessState =
  | { readonly state: "applied" }
  | { readonly state: "applying" }
  | { readonly state: "failed"; readonly error: string };

export interface Snapshot {
  readonly circles: ReadonlyArray<Circle>;
  readonly resources: ReadonlyArray<Resource>;
  readonly places: Readonly<Record<string, Point>>;
  readonly shareSettings: Readonly<Record<string, ShareSetting>>;
  readonly stacks: ReadonlyArray<Stack>;
  readonly revisions: ReadonlyArray<RevisionView>;
  readonly access: Readonly<Record<string, AccessState>>;
  /** K-408: Access applications that kitshn did not make but that cover a kitshn address. */
  readonly accessWarnings: ReadonlyArray<string>;
  /** K-110: sessions that the last sign-out everywhere did not end, with "Retry sign-out"; null when all ended. */
  readonly signOutWarning: string | null;
  /** K-1508: old History entries that the one-time rewording could not reword, until the next daily run. */
  readonly historyWarning: string | null;
  readonly paused: PauseMode | null;
  /** K-819: the repos that deployed or wait to deploy, newest first. */
  readonly repos: ReadonlyArray<RepoView>;
  /** K-909: the cards that a deploy made; only these show "Remove app". */
  readonly deployedCards: ReadonlyArray<string>;
  /** K-1113: the cards with a stored icon, each with the hash of its bytes, which versions its address. */
  readonly icons: Readonly<Record<string, string>>;
  /** K-1504: who paused and when, while paused. */
  readonly pausedBy: { readonly actor: Actor; readonly at: number } | null;
  readonly machines: ReadonlyArray<MachineView>;
  /** The newest jobs, with their output cut to 4,000 characters. */
  readonly jobs: ReadonlyArray<JobView>;
  /** K-617: the release of this kitshn; "Update daemon" installs the daemon of this release. */
  readonly version: string;
  /** The Zero Trust team domain; people enroll a passkey at `https://<team>/AddMfaDevice` (K-103). */
  readonly accessTeam: string;
  /** The zone that sites, pages and files live on (K-1111). */
  readonly zone: string;
  readonly me: Actor;
  /** The newest revision in this snapshot; a map shows a held edit until a snapshot reaches it. */
  readonly revision: number;
}

export type ServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  /** One machine changed (status or sample); cheaper than a whole snapshot. */
  | { readonly type: "machine"; readonly view: MachineView }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly ok: true;
      readonly revision: number | null;
      /** K-909: what an undo of an app removal started again, or why it did not. */
      readonly notes: ReadonlyArray<string>;
    }
  | { readonly type: "result"; readonly requestId: string; readonly ok: false; readonly error: string };

export interface MachineView {
  readonly machine: Machine;
  readonly online: boolean;
  readonly lastSeen: number | null;
  readonly status: MachineStatus | null;
  readonly sample: Sample | null;
  /** K-524: the system of the last status, also while offline; null before the first status or for another system. */
  readonly os: MachineOs | null;
  /** K-1708: the last failed challenge since kitshn started, until the next one passes. */
  readonly keyFailure: { readonly at: number; readonly reason: string } | null;
  /** K-909: idle volumes of kitshn apps that have no card; each has its own delete. */
  readonly orphanVolumes: ReadonlyArray<ProjectVolume>;
}

export interface JobView {
  readonly id: number;
  readonly machineId: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly command: Command;
  readonly state: "queued" | "sent" | "done" | "failed" | "expired";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly actor: string;
  readonly exitCode: number | null;
  readonly output: string;
}
