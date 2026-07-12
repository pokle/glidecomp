// The committed state of this module is `null`: production (and local) Pages
// Functions reach the workers through service bindings. Branch preview deploys
// OVERWRITE this file (web/scripts/preview/deploy-stack.ts, called from the
// Branch Deploy workflow) with the branch's per-branch worker URLs before
// `wrangler pages deploy`, because the Pages Preview environment's service
// bindings are one fixed set shared by every branch — they can't do per-branch
// routing, while per-deployment Functions bundles can. Never commit a non-null
// version.
import type { PreviewBackends } from "./preview-backends-types";
export type { PreviewBackends } from "./preview-backends-types";

export const previewBackends: PreviewBackends | null = null;
