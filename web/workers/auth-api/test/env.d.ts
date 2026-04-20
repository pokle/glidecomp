import type { D1Migration } from "cloudflare:test";
import type { AuthEnv } from "../src/auth";

declare module "cloudflare:test" {
  interface ProvidedEnv extends AuthEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}
