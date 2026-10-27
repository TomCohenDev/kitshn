import { ADMIN_RESOURCE_ID, type Circle, type Member, type State, shareKey, sharesOf } from "./model.ts";

/** An Access rule, in the shape of the Cloudflare API. */
export type Rule =
  | { readonly email: { readonly email: string } }
  | { readonly email_domain: { readonly domain: string } }
  | { readonly ip: { readonly ip: string } }
  | { readonly service_token: { readonly token_id: string } }
  | { readonly everyone: Record<string, never> };

export interface PolicyBody {
  readonly name: string;
  readonly decision: "allow" | "bypass" | "non_identity";
  readonly include: ReadonlyArray<Rule>;
  readonly require: ReadonlyArray<Rule>;
  readonly exclude: ReadonlyArray<Rule>;
  readonly mfa_config?: {
    readonly allowed_authenticators: ReadonlyArray<"biometrics" | "security_key">;
    readonly session_duration: string;
  };
}

export interface AppBody {
  readonly name: string;
  readonly type: "self_hosted";
  readonly domain: string;
  readonly session_duration: string;
  /** Keys of `DesiredAccess.policies`, in precedence order. */
  readonly policyKeys: ReadonlyArray<string>;
}

export interface DesiredAccess {
  readonly policies: ReadonlyMap<string, PolicyBody>;
  readonly apps: ReadonlyMap<string, AppBody>;
}

export const PASSKEY_MFA = {
  allowed_authenticators: ["biometrics", "security_key"],
  session_duration: "24h",
} as const;

/** Names of everything kitshn makes in Access start with this, so kitshn never touches other objects (K-408). */
export const ACCESS_NAME_PREFIX = "kitshn ";

export const peoplePolicyName = (circle: Pick<Circle, "name">) => `${ACCESS_NAME_PREFIX}circle ${circle.name}`;
export const tokenPolicyName = (circle: Pick<Circle, "name">) =>
  `${ACCESS_NAME_PREFIX}circle ${circle.name} (devices and networks)`;
export const appName = (resourceName: string) =>
  resourceName.startsWith(ACCESS_NAME_PREFIX) ? resourceName : `${ACCESS_NAME_PREFIX}${resourceName}`;

const personRule = (member: Member): Rule | null =>
  member._tag === "email"
    ? { email: { email: member.email } }
    : member._tag === "domain"
      ? { email_domain: { domain: member.domain } }
      : null;

/** Machines get a service token in milestone 2 (K-107); until then they compile to no rule (closed). */
const tokenRule = (member: Member): Rule | null =>
  member._tag === "device" ? { service_token: { token_id: member.tokenId } } : null;

const networkRule = (member: Member): Rule | null =>
  member._tag === "ip" ? { ip: { ip: member.range } } : null;

const present = <T>(values: ReadonlyArray<T | null>): Array<T> => values.filter((value) => value !== null);

/**
 * K-402: a circle becomes reusable policies. Access needs the Service Auth decision for service tokens and
 * networks without login, so a circle makes up to two policies: people (allow, with the passkey check of
 * K-103) and devices and networks (non_identity). "Everyone" makes one Bypass policy (K-403).
 */
export function circlePolicies(circle: Circle): Map<string, PolicyBody> {
  const policies = new Map<string, PolicyBody>();
  const people = present(circle.members.map(personRule));
  const tokens = present(circle.members.map(tokenRule));
  const networks = present(circle.members.map(networkRule));
  const base = { exclude: [] as Array<Rule> };
  const mfa = circle.needsPasskey ? { mfa_config: PASSKEY_MFA } : {};
  const isPublic = circle.members.some((member) => member._tag === "everyone");

  if (circle.match === "any") {
    if (isPublic) {
      policies.set(`policy:${circle.id}:people`, {
        ...base,
        name: peoplePolicyName(circle),
        decision: "bypass",
        include: [{ everyone: {} }],
        require: [],
      });
      return policies;
    }
    if (people.length > 0) {
      policies.set(`policy:${circle.id}:people`, {
        ...base,
        ...mfa,
        name: peoplePolicyName(circle),
        decision: "allow",
        include: people,
        require: [],
      });
    }
    if (tokens.length + networks.length > 0) {
      policies.set(`policy:${circle.id}:tokens`, {
        ...base,
        name: tokenPolicyName(circle),
        decision: "non_identity",
        include: [...tokens, ...networks],
        require: [],
      });
    }
    return policies;
  }

  // "All must match": the first rule includes, the others require. People and tokens never meet in one
  // request, so a circle with both only lets people in. "Everyone" adds nothing to an "all" circle.
  if (people.length > 0) {
    const [first, ...rest] = people;
    if (first) {
      policies.set(`policy:${circle.id}:people`, {
        ...base,
        ...mfa,
        name: peoplePolicyName(circle),
        decision: "allow",
        include: [first],
        require: [...rest, ...networks],
      });
    }
    return policies;
  }
  // Two tokens never both match one request, so such a circle matches nobody and gets no policy.
  const [first, ...rest] = [...tokens, ...networks];
  if (first && tokens.length <= 1) {
    policies.set(`policy:${circle.id}:tokens`, {
      ...base,
      name: tokenPolicyName(circle),
      decision: "non_identity",
      include: [first],
      require: rest,
    });
  }
  if (!first && isPublic) {
    policies.set(`policy:${circle.id}:people`, {
      ...base,
      name: peoplePolicyName(circle),
      decision: "bypass",
      include: [{ everyone: {} }],
      require: [],
    });
  }
  return policies;
}

/** Resource kinds that the Worker serves and checks itself (K-404) get no Access application. */
const WORKER_CHECKED = new Set(["page", "file"]);

/** K-401, K-402: the Access objects that the shares compile to. */
export function desiredAccess(state: State, now: number): DesiredAccess {
  const policies = new Map<string, PolicyBody>();
  const apps = new Map<string, AppBody>();
  for (const resource of state.resources.values()) {
    if (WORKER_CHECKED.has(resource.kind) || resource.addresses.length === 0) continue;
    const policyKeys: Array<string> = [];
    for (const share of sharesOf(state, resource)) {
      if (share.circle.endsAt !== null && share.circle.endsAt <= now) continue;
      const shareEnds = state.shareSettings.get(shareKey(resource.id, share.circle.id))?.endsAt ?? null;
      if (shareEnds !== null && shareEnds <= now) continue;
      for (const [key, body] of circlePolicies(share.circle)) {
        policies.set(key, body);
        policyKeys.push(key);
      }
    }
    // Bypass and Service Auth policies first, as the Access dashboard orders them.
    const order = { bypass: 0, non_identity: 1, allow: 2 } as const;
    policyKeys.sort((a, b) => order[policies.get(a)!.decision] - order[policies.get(b)!.decision]);
    for (const address of resource.addresses) {
      apps.set(`app:${resource.id}:${address}`, {
        name: appName(resource.name),
        type: "self_hosted",
        domain: address,
        // K-109
        session_duration: resource.id === ADMIN_RESOURCE_ID ? "24h" : "720h",
        policyKeys,
      });
    }
  }
  return { policies, apps };
}
