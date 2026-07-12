#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Provision + deploy the per-branch preview stack for one branch (see lib.ts
 * for what a stack is). Idempotent: safe to run on every push.
 *
 *   bun web/scripts/preview/deploy-stack.ts <branch-name>
 *
 * Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (the same ones CI uses;
 * the token additionally needs D1:Edit and Workers R2 Storage:Edit for the
 * create/delete lifecycle). Steps:
 *
 *   1. ensure the branch's D1 database + R2 bucket exist (free-tier D1 quota
 *      failures get an actionable message)
 *   2. generate the three wrangler.preview.json configs
 *   3. deploy the shared workers (airscore-api-preview, preview-blackhole),
 *      then the branch's auth + competition workers
 *   4. ensure the auth worker has a per-stack BETTER_AUTH_SECRET
 *   5. apply D1 migrations to the branch database
 *   6. write functions/lib/preview-backends.ts so the branch's Pages Functions
 *      bundle routes to these workers (build + `wrangler pages deploy` after
 *      this script — never before)
 *
 * Emits GitHub outputs (slug, alias_url, d1_created, comp_config) when run in
 * Actions. Seeding is a separate step — CI seeds when d1_created is true or
 * the commit message asks for it ([reseed]).
 */

import { randomBytes } from 'node:crypto';
import {
  stackNames,
  ensureD1,
  ensureR2Bucket,
  generateStackConfigs,
  wrangler,
  workersSubdomain,
  writePreviewBackends,
  githubOutput,
  SHARED_AIRSCORE_WORKER,
} from './lib';

const branch = process.argv[2];
if (!branch) {
  console.error('Usage: bun web/scripts/preview/deploy-stack.ts <branch-name>');
  process.exit(1);
}

const names = stackNames(branch);
console.log(`Deploying preview stack for "${branch}" → slug "${names.slug}"`);
console.log(`  frontend will be ${names.aliasUrl}`);

// 1. Data resources.
const d1 = await ensureD1(names.resource);
await ensureR2Bucket(names.resource);

// 2. Generated configs.
const configs = generateStackConfigs(names, d1.id);

// 3. Workers. Shared ones first (the comp worker's AIRSCORE_API service
// binding requires its target to exist), then auth (comp binds it), then comp.
console.log(`  deploying ${SHARED_AIRSCORE_WORKER}…`);
wrangler(['deploy', '--config', configs.airscoreConfig]);
console.log(`  deploying preview-blackhole…`);
wrangler(['deploy', '--config', 'web/workers/preview-blackhole/wrangler.toml']);
console.log(`  deploying ${names.authWorker}…`);
wrangler(['deploy', '--config', configs.authConfig]);

// 4. Per-stack auth secret: created once, kept across pushes so sessions
// survive redeploys; never printed. (`secret put` must follow the first
// deploy — the script has to exist.)
const secretList = wrangler(['secret', 'list', '--config', configs.authConfig]);
if (!secretList.includes('BETTER_AUTH_SECRET')) {
  console.log('  setting BETTER_AUTH_SECRET…');
  wrangler(['secret', 'put', 'BETTER_AUTH_SECRET', '--config', configs.authConfig], {
    input: randomBytes(32).toString('hex'),
  });
}

console.log(`  deploying ${names.compWorker}…`);
wrangler(['deploy', '--config', configs.compConfig]);

// 5. Migrations (fresh DBs get the full chain; existing ones just the delta).
console.log('  applying D1 migrations…');
wrangler(['d1', 'migrations', 'apply', names.resource, '--config', configs.authConfig, '--remote']);

// 6. Route the Pages Functions at this stack.
const subdomain = await workersSubdomain();
const authApiUrl = `https://${names.authWorker}.${subdomain}.workers.dev`;
const compApiUrl = `https://${names.compWorker}.${subdomain}.workers.dev`;
writePreviewBackends(authApiUrl, compApiUrl);

githubOutput({
  slug: names.slug,
  alias_url: names.aliasUrl,
  auth_api_url: authApiUrl,
  comp_api_url: compApiUrl,
  d1_created: String(d1.created),
  comp_config: configs.compConfig,
});
