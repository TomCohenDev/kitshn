// Schemas for input that crosses the wire. The UI imports only model.ts, so effect stays out of its bundle.
import { Schema } from "effect";
import type { Edit, Actor } from "./changes.ts";
import * as Model from "./model.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -1e6, maximum: 1e6 }));
const Time = Schema.Finite;

export const Level = Schema.Literals(Model.LEVELS);

export const Member = Schema.Union([
  Schema.TaggedStruct("email", { email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) }),
  Schema.TaggedStruct("domain", { domain: Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+\.[a-z]{2,}$/)) }),
  Schema.TaggedStruct("ip", { range: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F:.]+\/\d{1,3}$/)) }),
  Schema.TaggedStruct("device", { tokenId: Schema.String, clientId: Schema.String, name: Name }),
  Schema.TaggedStruct("machine", { machineId: Id }),
  Schema.TaggedStruct("everyone", {}),
]);

export const Circle = Schema.Struct({
  id: Id,
  name: Name,
  color: Schema.String.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/)),
  level: Level,
  members: Schema.Array(Member).check(Schema.isMaxLength(200)),
  match: Schema.Literals(["any", "all"]),
  needsPasskey: Schema.Boolean,
  endsAt: Schema.NullOr(Time),
  x: Coordinate,
  y: Coordinate,
  r: Schema.Finite.check(Schema.isBetween({ minimum: 40, maximum: 1e5 })),
});

export const Point = Schema.Struct({ x: Coordinate, y: Coordinate });

export const ShareSetting = Schema.Struct({ level: Schema.NullOr(Level), endsAt: Schema.NullOr(Time) });

export const Edit_ = Schema.Union([
  Schema.TaggedStruct("circle", { id: Schema.String, after: Schema.NullOr(Circle) }),
  Schema.TaggedStruct("place", { id: Schema.String, after: Schema.NullOr(Point) }),
  Schema.TaggedStruct("shareSetting", {
    resourceId: Schema.String,
    circleId: Schema.String,
    after: Schema.NullOr(ShareSetting),
  }),
]);

export const Actor_ = Schema.Union([
  Schema.TaggedStruct("person", { email: Schema.String }),
  Schema.TaggedStruct("device", { clientId: Schema.String, name: Schema.String }),
  Schema.TaggedStruct("kitshn", { reason: Schema.String }),
]);

/** Messages from a map client, over the WebSocket or as a POST body. */
export const ClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("apply"),
    requestId: Schema.String,
    edits: Schema.Array(Edit_).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  Schema.Struct({ type: Schema.Literal("undo"), requestId: Schema.String, revision: Schema.Int }),
]);
export type ClientMessage = typeof ClientMessage.Type;

// The schemas and the model types must describe the same values.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const agree = <T extends true>(_: T) => _;
agree<Same<typeof Member.Type, Model.Member>>(true);
agree<Same<typeof Circle.Type, Model.Circle>>(true);
agree<Same<typeof Point.Type, Model.Point>>(true);
agree<Same<typeof ShareSetting.Type, Model.ShareSetting>>(true);
agree<Same<typeof Edit_.Type, Edit>>(true);
agree<Same<typeof Actor_.Type, Actor>>(true);
