import type { Actor } from "./changes.ts";
import type { Command, Machine, MachineStatus, Sample } from "./machine.ts";
import type { Circle, PauseMode, Point, Resource, ShareSetting, Stack } from "./model.ts";
import type { RepoGate } from "./repos.ts";

/** K-819: `resourceIds` are the cards that this repo deployed, which the card panel matches. */
export type RepoView = RepoGate & { readonly resourceIds: ReadonlyArray<string> };

export interface RevisionView {
  readonly id: number;
  readonly at: number;
  readonly actor: Actor;
  readonly summary: string;
  readonly undoes: number | null;
  readonly undoneBy: number | null;
  /** False for a revision that records an action, such as a shell command, and changes nothing. */
  readonly undoable: boolean;
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
  readonly paused: PauseMode | null;
  /** K-819: the repos that deployed or wait to deploy, newest first. */
  readonly repos: ReadonlyArray<RepoView>;
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
    }
  | { readonly type: "result"; readonly requestId: string; readonly ok: false; readonly error: string };

export interface MachineView {
  readonly machine: Machine;
  readonly online: boolean;
  readonly lastSeen: number | null;
  readonly status: MachineStatus | null;
  readonly sample: Sample | null;
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
