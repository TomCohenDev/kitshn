import type { Kitshn } from "./kitshn.ts";

export interface Env {
  readonly ASSETS: Fetcher;
  readonly KITSHN: DurableObjectNamespace<Kitshn>;
  /** The admin host, for example `kit.yarden-zamir.com` (K-1208). */
  readonly KITSHN_HOST: string;
  /** The Zero Trust team domain, for example `team.cloudflareaccess.com`. */
  readonly ACCESS_TEAM_DOMAIN: string;
  /** The audience tag of the admin Access application (the map and `/api`). */
  readonly ACCESS_ADMIN_AUD: string;
  /** The audience tag of the `/connect` Access application (daemons, K-604). */
  readonly ACCESS_CONNECT_AUD: string;
  /** Comma-separated owner emails; they seed the Owner circle on the first start (K-1204). */
  readonly OWNER_EMAILS: string;
  /** Optional JSON list of service tokens that join the Owner circle on the first start, for agents (K-106). */
  readonly OWNER_DEVICES?: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  /** The zone that kitshn publishes on (K-1111), and its id. */
  readonly KITSHN_ZONE: string;
  readonly CLOUDFLARE_ZONE_ID: string;
  /** K-811: comma-separated GitHub user ids whose repos may deploy. Empty refuses every deploy. */
  readonly DEPLOY_OWNER_IDS: string;
  /** The API token that writes Access changes (K-406). Missing in local development. */
  readonly CLOUDFLARE_API_TOKEN?: string;
  /** Local development only: the email to act as. The Worker honours it only on localhost. */
  readonly DEV_IDENTITY?: string;
  /** Local development only: seed sample cards. The Durable Object honours it only when the host is localhost. */
  readonly DEV_DEMO?: string;
}
