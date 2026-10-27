import type { Kitshn } from "./kitshn.ts";

export interface Env {
  readonly ASSETS: Fetcher;
  readonly KITSHN: DurableObjectNamespace<Kitshn>;
  /** The admin host, for example `kit.yarden-zamir.com` (K-1208). */
  readonly KITSHN_HOST: string;
  /** The Zero Trust team domain, for example `team.cloudflareaccess.com`. */
  readonly ACCESS_TEAM_DOMAIN: string;
  /** Comma-separated audience tags of the Access applications in front of this Worker. */
  readonly ACCESS_AUDS: string;
  /** Comma-separated owner emails; they seed the Owner circle on the first start (K-1204). */
  readonly OWNER_EMAILS: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  /** The API token that writes Access changes (K-406). Missing in local development. */
  readonly CLOUDFLARE_API_TOKEN?: string;
  /** Local development only: the email to act as. The Worker honours it only on localhost. */
  readonly DEV_IDENTITY?: string;
  /** Local development only: seed sample cards. The Durable Object honours it only when the host is localhost. */
  readonly DEV_DEMO?: string;
}
