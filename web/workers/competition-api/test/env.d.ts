import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // `env` from "cloudflare:test" is typed as Cloudflare.Env.
    // R2Bucket is provided automatically by miniflare when configured via wrangler.toml
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      SAMPLE_TASK_XCTSK: string;
      SAMPLE_IGC_FILES: string; // JSON: { [filename: string]: string }
      TEST_SESSION_SIGNING_JWK: string; // JSON private JWK — see vitest.config.ts
    }
  }
}
