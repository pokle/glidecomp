#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Tear down one branch's preview stack (workers, D1 database, R2 bucket).
 * Idempotent — anything already gone is skipped. Shared preview workers
 * (airscore-api-preview, preview-blackhole) and the Pages branch preview
 * deployments themselves are left alone.
 *
 *   bun web/scripts/preview/destroy-stack.ts --branch <branch-name>
 *   bun web/scripts/preview/destroy-stack.ts --slug <slug>
 *
 * Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
 */

import { branchSlug, destroyStack } from './lib';

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const branch = argValue('--branch');
const slugArg = argValue('--slug');
const slug = slugArg ?? (branch ? branchSlug(branch) : undefined);
if (!slug) {
  console.error(
    'Usage: bun web/scripts/preview/destroy-stack.ts --branch <branch-name> | --slug <slug>',
  );
  process.exit(1);
}

await destroyStack(slug);
