import type { Actor } from "./changes.ts";
import type { Circle, Point, Resource, ShareSetting } from "./model.ts";

export interface RevisionView {
  readonly id: number;
  readonly at: number;
  readonly actor: Actor;
  readonly summary: string;
  readonly undoes: number | null;
  readonly undoneBy: number | null;
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
  readonly revisions: ReadonlyArray<RevisionView>;
  readonly access: Readonly<Record<string, AccessState>>;
  readonly me: Actor;
}

export type ServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly ok: true;
      readonly revision: number | null;
    }
  | { readonly type: "result"; readonly requestId: string; readonly ok: false; readonly error: string };
