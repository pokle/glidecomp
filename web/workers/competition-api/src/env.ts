import type { EmailSendBinding } from "./track-notice-email";

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  AUTH_API: Fetcher;
  AIRSCORE_API: Fetcher;
  SQIDS_ALPHABET: string;
  glidecomp_scores_cache: KVNamespace;
  /**
   * Cloudflare Email Service, for the "your track was replaced" notice.
   * Optional: absent in local dev and in the worker tests, where sending
   * no-ops rather than needing a mail mock.
   */
  EMAIL?: EmailSendBinding;
  /** The canonical site origin, used to build links inside emails. */
  SITE_ORIGIN?: string;
};

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
};
