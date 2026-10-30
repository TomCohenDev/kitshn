// K-630: what a daemon finds when it checks its providers and its links, and sends to kitshn.
import { Schema } from "effect";

/** K-630: a daemon checks this often. */
export const HEALTH_INTERVAL_MS = 10 * 60_000;
/** K-630: the most providers and links that one report names, so it fits the machine socket's attachment. */
export const HEALTH_MAX_LINKS = 24;
export const HEALTH_ERROR_MAX = 160;

const Failures = {
  /** The failed checks in a row, this one included; 0 when this one passed. */
  failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** When the failures in a row started; null when this check passed. */
  since: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(HEALTH_ERROR_MAX))),
};

export const ProviderHealth = Schema.Struct({ provider: Schema.String, ...Failures });
export type ProviderHealth = typeof ProviderHealth.Type;

/** One link: a provider of this machine reaches its card on another machine through the link proxy (K-1609). */
export const LinkHealth = Schema.Struct({
  provider: Schema.String,
  machineId: Schema.String,
  /** The HTTP status of the answer; null when no answer came. */
  status: Schema.NullOr(Schema.Int),
  ms: Schema.Number,
  ...Failures,
});
export type LinkHealth = typeof LinkHealth.Type;

export const HealthReport = Schema.Struct({
  at: Schema.Number,
  providers: Schema.Array(ProviderHealth).check(Schema.isMaxLength(HEALTH_MAX_LINKS)),
  links: Schema.Array(LinkHealth).check(Schema.isMaxLength(HEALTH_MAX_LINKS)),
});
export type HealthReport = typeof HealthReport.Type;
