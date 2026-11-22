import type { D1Migration } from "cloudflare:test";
import type { AuthEnv } from "../src/auth";

declare global {
  namespace Cloudflare {
    // `env` from "cloudflare:test" is typed as Cloudflare.Env.
    interface Env extends AuthEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
