// Section 7: what a provider (K-704) tells the daemon, and what the daemon passes on to kitshn over `/connect`.
import { Schema, SchemaGetter } from "effect";

/** K-704: names that a provider cannot take, because kitshn's own kinds start with them (K-301). */
export const RESERVED_PROVIDERS: ReadonlySet<string> = new Set([
  "kitshn",
  "site",
  "repo",
  "machine",
  "page",
  "file",
]);

/** K-704: limits per machine, so one provider cannot fill the Durable Object. */
export const PROVIDER_LIMITS = {
  providers: 8,
  kinds: 20,
  commands: 40,
  /** The cards of all providers of one machine. */
  resources: 500,
  facts: 20,
  stickers: 8,
  lists: 4,
  rows: 100,
  columns: 8,
  /** K-709: each part of a desired state, in bytes of its JSON. */
  stateBytes: 64 * 1024,
  /** K-1625: one resource with its facts, stickers and lists, in bytes of its JSON, so a card stays far below a row. */
  resourceBytes: 64 * 1024,
} as const;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const only = (chars: string) => (text: string) => [...text].every((char) => chars.includes(char));

export const isProviderName = (name: string) =>
  name.length >= 1 &&
  name.length <= 32 &&
  LOWER.includes(name[0] ?? "") &&
  only(`${LOWER}${DIGITS}-`)(name) &&
  !RESERVED_PROVIDERS.has(name);

export const ProviderName = Schema.String.check(
  Schema.makeFilter((name: string) => isProviderName(name) || "a provider name of a-z, 0-9 and -"),
);
/** K-302: a kind id starts with the provider name and a dot, for example `t3.thread`. */
const KindId = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(64),
  Schema.makeFilter((id: string) => only(`${LOWER}${DIGITS}.-`)(id) || "a kind id of a-z, 0-9, . and -"),
);
/** The provider's own id of a resource, unique within the provider. */
const LocalId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.makeFilter(
    (id: string) =>
      only(`${LOWER}${LOWER.toUpperCase()}${DIGITS}._-`)(id) || "an id of a-z, A-Z, 0-9, ., _ and -",
  ),
);
const LevelName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20),
  Schema.makeFilter((name: string) => only(`${LOWER}-`)(name) || "a level name of a-z and -"),
);

/**
 * K-713: the levels of a provider kind, each named by the kitshn level that it stands for, so a circle level
 * maps to it by K-206: `{ view: "view", use: "send" }` gives "send" to a circle with `use` or `control`. A kind
 * without levels is not shareable, and the map hides it.
 */
export const ProviderLevels = Schema.Struct({
  view: Schema.optionalKey(LevelName),
  use: Schema.optionalKey(LevelName),
  control: Schema.optionalKey(LevelName),
});
export type ProviderLevels = typeof ProviderLevels.Type;

const SettingId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
  Schema.makeFilter(
    (id: string) => only(`${LOWER}${LOWER.toUpperCase()}${DIGITS}-`)(id) || "an id of a-z, A-Z, 0-9 and -",
  ),
);

/** K-717: a setting of each card of a kind, with a closed list of values; kitshn keeps one value per card. */
export const ProviderCardSetting = Schema.Struct({
  id: SettingId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  values: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(10),
  ),
  default: Schema.String,
});
export type ProviderCardSetting = typeof ProviderCardSetting.Type;

export const ProviderKind = Schema.Struct({
  id: KindId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  levels: ProviderLevels,
  /**
   * K-709: a kind of desired state: one JSON value with a shared part and one part per machine, and no cards. The
   * schema is a JSON Schema of the value, for the editor of the map.
   */
  state: Schema.optionalKey(Schema.Struct({ schema: Schema.optionalKey(Schema.Unknown) })),
  /** K-717: settings of each card of this kind. */
  settings: Schema.optionalKey(Schema.Array(ProviderCardSetting).check(Schema.isMaxLength(4))),
});
export type ProviderKind = typeof ProviderKind.Type;

/** K-707: a command that the provider runs. With no kinds, it is a command of the machine card. */
export const ProviderCommand = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(40),
    Schema.makeFilter((id: string) => only(`${LOWER}${DIGITS}-`)(id) || "a command id of a-z, 0-9 and -"),
  ),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  kinds: Schema.Array(KindId).check(Schema.isMaxLength(20)),
  /** K-1615: the map asks before it runs the command. */
  confirm: Schema.Boolean,
});
export type ProviderCommand = typeof ProviderCommand.Type;

/** K-1625: `version` is compared within one kind, and `busy` holds "when online and idle" jobs (K-1608). */
export const FACT_ROLES = ["version", "busy"] as const;
export const ProviderFact = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  value: Schema.String.check(Schema.isMaxLength(200)),
  role: Schema.optionalKey(Schema.Literals(FACT_ROLES)),
});
export type ProviderFact = typeof ProviderFact.Type;

export const STICKER_TONES = ["info", "good", "warn", "bad"] as const;
const Link = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (link: string) => link.startsWith("https://") || link.startsWith("http://") || "an http or https link",
  ),
);
export const ProviderSticker = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  tone: Schema.Literals(STICKER_TONES),
  link: Schema.optionalKey(Link),
});
export type ProviderSticker = typeof ProviderSticker.Type;

const Text = Schema.String.check(Schema.isMaxLength(200));
/**
 * K-1625: a list on a card, such as the scheduled tasks (K-1614) or the sessions (K-1602) of a machine. A row names
 * the commands (K-707) that the card menu offers for it; the command event carries the row id.
 */
export const ProviderList = Schema.Struct({
  id: SettingId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  columns: Schema.Array(
    Schema.Struct({ id: SettingId, title: Schema.String.check(Schema.isMaxLength(40)) }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(PROVIDER_LIMITS.columns)),
  rows: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      cells: Schema.Record(Schema.String, Text),
      commands: Schema.optionalKey(
        Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(Schema.isMaxLength(8)),
      ),
    }),
  ).check(Schema.isMaxLength(PROVIDER_LIMITS.rows)),
});
export type ProviderList = typeof ProviderList.Type;

/** K-304: what a provider reports; kitshn sets "offline" itself while the provider is not connected. */
export const PROVIDER_STATUSES = ["running", "stopped", "deploying", "failed", "unknown"] as const;

/**
 * K-705: one resource. `parent` stacks it with the card of another resource of the same provider (K-508). `site`
 * makes the card the live site `<name>.<zone>` of its machine (K-1104), served from a local port.
 */
export const ProviderResource = Schema.Struct({
  id: LocalId,
  kind: KindId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  status: Schema.Literals(PROVIDER_STATUSES),
  parent: Schema.optionalKey(LocalId),
  site: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(63),
        Schema.makeFilter(
          (name: string) =>
            (only(`${LOWER}${DIGITS}-`)(name) && !name.startsWith("-") && !name.endsWith("-")) ||
            "a DNS label of a-z, 0-9 and -",
        ),
      ),
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    }),
  ),
  facts: Schema.optionalKey(Schema.Array(ProviderFact).check(Schema.isMaxLength(PROVIDER_LIMITS.facts))),
  stickers: Schema.optionalKey(
    Schema.Array(ProviderSticker).check(Schema.isMaxLength(PROVIDER_LIMITS.stickers)),
  ),
  lists: Schema.optionalKey(Schema.Array(ProviderList).check(Schema.isMaxLength(PROVIDER_LIMITS.lists))),
});
export type ProviderResource = typeof ProviderResource.Type;

/** K-704: one provider of a machine as the daemon reports it to kitshn: its last registration and its resources. */
export const ProviderReport = Schema.Struct({
  name: ProviderName,
  /** False while no connection of the provider is open; kitshn then shows its cards as offline. */
  online: Schema.Boolean,
  kinds: Schema.Array(ProviderKind).check(Schema.isMaxLength(PROVIDER_LIMITS.kinds)),
  commands: Schema.Array(ProviderCommand).check(Schema.isMaxLength(PROVIDER_LIMITS.commands)),
  resources: Schema.Array(ProviderResource).check(Schema.isMaxLength(PROVIDER_LIMITS.resources)),
});
export type ProviderReport = typeof ProviderReport.Type;
export const decodeProviderReports = Schema.decodeUnknownSync(
  Schema.Array(ProviderReport).check(Schema.isMaxLength(PROVIDER_LIMITS.providers)),
);

/**
 * K-706: one member rule of a circle. `clientId` is what the Access JWT carries in `common_name`, so the provider
 * matches a device or a machine from the JWT alone.
 */
const KnownRule = Schema.Union([
  Schema.Struct({ email: Schema.String }),
  Schema.Struct({ domain: Schema.String }),
  Schema.Struct({ ip: Schema.String }),
  Schema.Struct({ device: Schema.Struct({ clientId: Schema.String, name: Schema.String }) }),
  Schema.Struct({ machine: Schema.Struct({ machineId: Schema.String, clientId: Schema.String }) }),
  Schema.Struct({ everyone: Schema.Literal(true) }),
]);
/** A rule of a type that this reader does not know. It never matches, and in an "all" circle it fails the grant. */
const UnknownRule = Schema.Struct({ unknown: Schema.String });
const isKnownRule = Schema.is(KnownRule);

/**
 * K-706: a rule decodes forward compatibly: a type that a newer kitshn adds becomes `{ unknown: <its key> }`, so the
 * rest of the table still decodes and the new rule never widens access.
 */
export const GrantRule = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Union([KnownRule, UnknownRule]), {
    decode: SchemaGetter.transform((value: unknown) =>
      isKnownRule(value)
        ? value
        : {
            unknown:
              typeof value === "object" && value !== null ? (Object.keys(value)[0] ?? "") : typeof value,
          },
    ),
    encode: SchemaGetter.transform((rule) => rule),
  }),
);
export type GrantRule = typeof GrantRule.Type;

/**
 * K-706: one share of a resource. `level` is the provider's name of the level. `endsAt` is the earlier of the end
 * of the circle and of the share (K-209), in ms; the provider ends the sessions of the share at that time itself.
 */
export const Grant = Schema.Struct({
  circle: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    match: Schema.Literals(["any", "all"]),
    needsPasskey: Schema.Boolean,
    rules: Schema.Array(GrantRule),
  }),
  level: Schema.String,
  endsAt: Schema.NullOr(Schema.Number),
});
export type Grant = typeof Grant.Type;

/** K-706: the grant table of each resource of one provider, by the provider's resource id. */
export const GrantTables = Schema.Record(Schema.String, Schema.Array(Grant));
export type GrantTables = typeof GrantTables.Type;

/**
 * K-704, K-705: why a provider's set of resources is not valid, or null. Each kind id starts with the provider name,
 * each command names known kinds, each resource has a known kind with levels and a known parent, and the cards and
 * the site names of all providers of the machine stay within the limits.
 */
export function reportProblem(
  report: ProviderReport,
  others: ReadonlyArray<ProviderReport>,
  takenSites: ReadonlySet<string>,
  /** The site names of kitshn itself, such as `pages` (K-817). */
  reserved: ReadonlySet<string>,
): string | null {
  const kinds = new Map(report.kinds.map((kind) => [kind.id, kind]));
  if (kinds.size !== report.kinds.length) return "two kinds have the same id.";
  for (const id of kinds.keys())
    if (!id.startsWith(`${report.name}.`) || id.length === report.name.length + 1)
      return `the kind ${id} does not start with ${report.name}. (K-302).`;
  for (const kind of kinds.values())
    for (const setting of kind.settings ?? [])
      if (!setting.values.includes(setting.default))
        return `the setting ${setting.id} of ${kind.id} has a default that is not one of its values.`;
  const commands = new Map(report.commands.map((command) => [command.id, command]));
  if (commands.size !== report.commands.length) return "two commands have the same id.";
  for (const command of report.commands)
    for (const kind of command.kinds)
      if (!kinds.has(kind)) return `the command ${command.id} names the unknown kind ${kind}.`;
  const ids = new Set(report.resources.map((resource) => resource.id));
  if (ids.size !== report.resources.length) return "two resources have the same id.";
  const sites = new Set<string>();
  for (const resource of report.resources) {
    const kind = kinds.get(resource.kind);
    if (!kind) return `the resource ${resource.id} has the unknown kind ${resource.kind}.`;
    if (Object.keys(kind.levels).length === 0)
      return `the kind ${kind.id} has no levels, so it has no cards (K-709).`;
    for (const list of resource.lists ?? []) {
      const columns = new Set(list.columns.map((column) => column.id));
      for (const row of list.rows) {
        for (const command of row.commands ?? [])
          if (!commands.get(command)?.kinds.includes(resource.kind))
            return `the list ${list.id} of ${resource.id} names the command ${command}, which its kind does not have.`;
        for (const key of Object.keys(row.cells))
          if (!columns.has(key))
            return `the row ${row.id} of the list ${list.id} has a cell ${key} that is no column.`;
      }
    }
    if (bytesOf(resource) > PROVIDER_LIMITS.resourceBytes)
      return `the resource ${resource.id} holds more than ${PROVIDER_LIMITS.resourceBytes} bytes.`;
    if (resource.parent !== undefined && (resource.parent === resource.id || !ids.has(resource.parent)))
      return `the resource ${resource.id} names the unknown parent ${resource.parent}.`;
    if (resource.site) {
      const name = resource.site.name;
      if (reserved.has(name)) return `the site name ${name} is a name of kitshn itself.`;
      if (sites.has(name) || takenSites.has(name)) return `the site name ${name} is in use on this machine.`;
      sites.add(name);
    }
  }
  for (const other of others)
    for (const resource of other.resources)
      if (resource.site && sites.has(resource.site.name))
        return `the site name ${resource.site.name} belongs to the provider ${other.name}.`;
  const total = others.reduce((sum, other) => sum + other.resources.length, report.resources.length);
  if (total > PROVIDER_LIMITS.resources)
    return `the providers of this machine would have ${total} resources, more than ${PROVIDER_LIMITS.resources}.`;
  if (!others.some((other) => other.name === report.name) && others.length >= PROVIDER_LIMITS.providers)
    return `this machine has ${PROVIDER_LIMITS.providers} providers already.`;
  return null;
}

/** K-709: the parts of a desired state that one machine gets: the shared part and its own; null where none is set. */
export const DesiredParts = Schema.Struct({ shared: Schema.Unknown, machine: Schema.Unknown });
export type DesiredParts = typeof DesiredParts.Type;

/** K-717: card setting values, by the provider's resource id, then by setting id. */
export const CardSettingValues = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String));
export type CardSettingValues = typeof CardSettingValues.Type;

/** K-1608: the keys of the pushes of kitshn, one per thing that a provider applies. */
export const pushKey = {
  grants: (provider: string) => `grants:${provider}`,
  settings: (provider: string) => `settings:${provider}`,
  desired: (provider: string, kind: string) => `desired:${provider}:${kind}`,
} as const;

/** The UTF-8 length of a value's JSON; this package runs without DOM types, so it counts by hand. */
function bytesOf(value: unknown): number {
  let bytes = 0;
  for (const char of JSON.stringify(value ?? null)) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * K-709: why a desired state part is refused, or null: the provider registered the kind with `state`, and the part
 * holds at most `PROVIDER_LIMITS.stateBytes`. The daemon checks it before it answers, and kitshn again when it writes.
 * kitshn does not check the value against the kind's schema; the provider validates what it applies.
 */
export function desiredProblem(
  kinds: ReadonlyArray<ProviderKind>,
  kind: string,
  value: unknown,
): string | null {
  if (!kinds.some((item) => item.id === kind && item.state !== undefined))
    return `the kind ${kind} has no desired state (K-709).`;
  if (bytesOf(value) > PROVIDER_LIMITS.stateBytes)
    return `a desired state part holds at most ${PROVIDER_LIMITS.stateBytes} bytes (K-709).`;
  return null;
}
