#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Destroy preview stacks whose branch no longer exists. Safety net for the
 * event-driven cleanup (branch-delete webhooks can be missed, and a stack
 * created from a branch that was force-renamed leaves no delete event).
 *
 * Reads the repository's live branch names on stdin (one per line — CI feeds
 * it `gh api .../branches`), slugs them the same way deploys do, then lists
 * the account's preview resources (D1 databases and workers carrying the
 * preview prefixes) and destroys every stack slug not backed by a live branch.
 *
 *   gh api repos/OWNER/REPO/branches --paginate --jq '.[].name' \
 *     | bun web/scripts/preview/sweep-stacks.ts
 *
 * Pass --dry-run to only report. Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
 */

import {
  branchSlug,
  destroyStack,
  listD1Databases,
  listWorkerScripts,
  RESOURCE_PREFIX,
  WORKER_PREFIXES,
} from './lib';

const dryRun = process.argv.includes('--dry-run');

const stdin = await new Response(process.stdin as unknown as ReadableStream).text();
const liveBranches = stdin
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
if (liveBranches.length === 0) {
  // An empty branch list means the input pipeline broke, not that the repo has
  // no branches (master always exists) — bail rather than sweep everything.
  console.error('No branch names on stdin — refusing to sweep. Pipe the live branch list in.');
  process.exit(1);
}
const liveSlugs = new Set(liveBranches.map(branchSlug));
console.log(`${liveBranches.length} live branches → ${liveSlugs.size} slugs`);

// Collect stack slugs from both resource kinds, so a half-created or
// half-destroyed stack (e.g. workers without a DB) still gets swept.
const slugs = new Set<string>();
for (const db of await listD1Databases()) {
  if (db.name.startsWith(RESOURCE_PREFIX)) slugs.add(db.name.slice(RESOURCE_PREFIX.length));
}
for (const script of await listWorkerScripts()) {
  for (const prefix of WORKER_PREFIXES) {
    if (script.startsWith(prefix)) slugs.add(script.slice(prefix.length));
  }
}

const orphans = [...slugs].filter((s) => !liveSlugs.has(s));
console.log(`${slugs.size} preview stacks found, ${orphans.length} orphaned`);

for (const slug of orphans) {
  if (dryRun) {
    console.log(`  would destroy: ${slug}`);
  } else {
    await destroyStack(slug);
  }
}
