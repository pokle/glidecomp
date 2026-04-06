import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/env";

declare module "cloudflare:test" {
  // R2Bucket is provided automatically by miniflare when configured via wrangler.toml
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
    SAMPLE_TASK_XCTSK: string;
    SAMPLE_IGC_FILES: string; // JSON: { [filename: string]: string }
  }
}
