#!/usr/bin/env bun
/**
 * One-off teardown for the preview infrastructure deployed by PR #317
 * (closed unmerged). Removes everything the abandoned per-branch preview
 * pipeline created:
 *
 *   - the branch stack for claude/cloudflare-workers-preview-6n5jod
 *     (workers auth-api-pv-* / competition-api-pv-*, D1 + R2
 *     glidecomp-pv-claude-cloudflare-workers-pr)
 *   - the shared workers the stack cleanup deliberately left alone:
 *     preview-blackhole and airscore-api-preview
 *
 * Idempotent; safe to re-run. Needs CLOUDFLARE_API_TOKEN +
 * CLOUDFLARE_ACCOUNT_ID. Delete this file (and the workflow that runs it)
 * once the teardown has succeeded.
 */

import { destroyStack, deleteWorkerScript } from './lib';

await destroyStack('claude/cloudflare-workers-preview-6n5jod');

for (const worker of ['preview-blackhole', 'airscore-api-preview']) {
  const deleted = await deleteWorkerScript(worker);
  if (!deleted) console.log(`  worker ${worker} already gone`);
}

console.log('PR #317 preview teardown complete.');
