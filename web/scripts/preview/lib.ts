// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Shared plumbing for per-branch preview stacks (see
 * docs/preview-environment-plan.md). A "stack" is everything one branch needs
 * to run in full isolation from production and from every other branch:
 *
 *   - D1 database  `glidecomp-pv-<slug>`   (auth + competition tables, like prod)
 *   - R2 bucket    `glidecomp-pv-<slug>`   (IGC track objects)
 *   - Workers      `auth-api-pv-<slug>`, `competition-api-pv-<slug>`
 *                  on workers.dev only — no glidecomp.com routes, so a preview
 *                  deploy structurally cannot touch production traffic or data.
 *
 * Shared across all stacks (read-only / branch-agnostic): `airscore-api-preview`
 * (upstream cache of xc.highcloud.net) and the two existing preview KV
 * namespaces. The frontend stays a Pages *branch preview*
 * (`https://<slug>.glidecomp.pages.dev`); its Functions reach the branch
 * workers by URL via the generated `functions/lib/preview-backends.ts`
 * (Pages preview-environment service bindings are one fixed set for ALL
 * branches, so bindings can't do per-branch routing — public worker URLs can).
 *
 * Worker configs are GENERATED (wrangler.preview.json, gitignored) from the
 * checked-in wrangler.toml files rather than using `[env.*]` blocks: named
 * environments inherit almost nothing, and a missed redeclaration (e.g. an
 * inherited production route) fails toward production. Generating from scratch
 * keeps the full preview config visible in one artifact and copies vars /
 * compatibility settings from the source of truth so drift is minimal.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** Every per-branch D1 database and R2 bucket carries this prefix. */
export const RESOURCE_PREFIX = 'glidecomp-pv-';
/** Per-branch worker names: `${WORKER_PREFIXES[i]}<slug>`. */
export const WORKER_PREFIXES = ['auth-api-pv-', 'competition-api-pv-'] as const;
/** Branch-agnostic preview workers (deployed idempotently, never destroyed). */
export const SHARED_AIRSCORE_WORKER = 'airscore-api-preview';
export const BLACKHOLE_WORKER = 'preview-blackhole';

const API = 'https://api.cloudflare.com/client/v4';

/**
 * The Cloudflare Pages branch-alias slug, per the documented behaviour
 * (CLAUDE.md "Branch preview deploys"): lowercase, non-alphanumerics to `-`,
 * truncated to 28 chars, no leading/trailing dash. Resource names reuse the
 * same slug so `<slug>.glidecomp.pages.dev` ↔ `glidecomp-pv-<slug>` map 1:1.
 */
export function branchSlug(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 28)
    .replace(/^-+|-+$/g, '');
}

export interface StackNames {
  slug: string;
  /** D1 database name and R2 bucket name (identical). */
  resource: string;
  authWorker: string;
  compWorker: string;
  aliasUrl: string;
}

export function stackNames(branch: string): StackNames {
  const slug = branchSlug(branch);
  if (!slug) throw new Error(`Branch name "${branch}" produced an empty slug`);
  return {
    slug,
    resource: `${RESOURCE_PREFIX}${slug}`,
    authWorker: `${WORKER_PREFIXES[0]}${slug}`,
    compWorker: `${WORKER_PREFIXES[1]}${slug}`,
    aliasUrl: `https://${slug}.glidecomp.pages.dev`,
  };
}

// --- Cloudflare REST API -----------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set (CI provides it; locally export it)`);
  return v;
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
  result_info?: { cursor?: string };
}

/**
 * Minimal Cloudflare v4 API client. Used for resource lifecycle (list/create/
 * delete of D1 + R2, worker script deletes, workers.dev subdomain) where the
 * REST API gives clean JSON; deploys/migrations/secrets go through wrangler.
 */
export async function cfApi<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<CfEnvelope<T>> {
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as CfEnvelope<T>;
  if (!json.success) {
    const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    const err = new Error(`Cloudflare API ${method} ${path} failed — ${msg}`) as Error & {
      codes?: number[];
      status?: number;
    };
    err.codes = json.errors?.map((e) => e.code) ?? [];
    err.status = res.status;
    throw err;
  }
  return json;
}

export function accountPath(sub: string): string {
  return `/accounts/${requireEnv('CLOUDFLARE_ACCOUNT_ID')}${sub}`;
}

/** `https://<name>.<subdomain>.workers.dev` — the account's workers.dev zone. */
export async function workersSubdomain(): Promise<string> {
  const { result } = await cfApi<{ subdomain: string }>('GET', accountPath('/workers/subdomain'));
  return result.subdomain;
}

// --- D1 / R2 lifecycle -------------------------------------------------------

interface D1Info {
  uuid: string;
  name: string;
}

export async function listD1Databases(): Promise<D1Info[]> {
  // The D1 list endpoint pages; 100 per page is far above the free-tier cap
  // (10 databases) and comfortably holds a paid account's preview churn too.
  const { result } = await cfApi<D1Info[]>('GET', accountPath('/d1/database?per_page=100'));
  return result;
}

export async function ensureD1(name: string): Promise<{ id: string; created: boolean }> {
  const existing = (await listD1Databases()).find((d) => d.name === name);
  if (existing) return { id: existing.uuid, created: false };
  try {
    const { result } = await cfApi<D1Info>('POST', accountPath('/d1/database'), { name });
    console.log(`  created D1 database ${name} (${result.uuid})`);
    return { id: result.uuid, created: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/limit|maximum|quota/i.test(msg)) {
      throw new Error(
        `${msg}\n\nThe account has hit its D1 database limit (10 on the free plan).\n` +
          `Free a slot by deleting a stale preview stack:\n` +
          `  bun web/scripts/preview/destroy-stack.ts --branch <old-branch>\n` +
          `(or run the "Preview Cleanup" workflow / upgrade to Workers Paid).`,
      );
    }
    throw err;
  }
}

export async function deleteD1(name: string): Promise<boolean> {
  const existing = (await listD1Databases()).find((d) => d.name === name);
  if (!existing) return false;
  await cfApi('DELETE', accountPath(`/d1/database/${existing.uuid}`));
  console.log(`  deleted D1 database ${name}`);
  return true;
}

export async function ensureR2Bucket(name: string): Promise<{ created: boolean }> {
  try {
    await cfApi('POST', accountPath('/r2/buckets'), { name });
    console.log(`  created R2 bucket ${name}`);
    return { created: true };
  } catch (err) {
    // 10004: "The bucket you tried to create already exists, and you own it."
    if (err instanceof Error && 'codes' in err && (err as { codes?: number[] }).codes?.includes(10004)) {
      return { created: false };
    }
    throw err;
  }
}

/** Empty then delete the bucket (the API refuses to delete a non-empty one). */
export async function deleteR2Bucket(name: string): Promise<boolean> {
  for (;;) {
    let listing: CfEnvelope<Array<{ key: string }>>;
    try {
      listing = await cfApi<Array<{ key: string }>>(
        'GET',
        accountPath(`/r2/buckets/${name}/objects?per_page=500`),
      );
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 404) {
        return false; // bucket never existed / already gone
      }
      throw err;
    }
    if (listing.result.length === 0) break;
    for (const obj of listing.result) {
      await cfApi(
        'DELETE',
        accountPath(`/r2/buckets/${name}/objects/${encodeURIComponent(obj.key)}`),
      );
    }
    console.log(`  deleted ${listing.result.length} objects from ${name}`);
  }
  await cfApi('DELETE', accountPath(`/r2/buckets/${name}`));
  console.log(`  deleted R2 bucket ${name}`);
  return true;
}

// --- worker scripts ----------------------------------------------------------

export async function listWorkerScripts(): Promise<string[]> {
  const { result } = await cfApi<Array<{ id: string }>>('GET', accountPath('/workers/scripts'));
  return result.map((s) => s.id);
}

export async function deleteWorkerScript(name: string): Promise<boolean> {
  try {
    await cfApi('DELETE', accountPath(`/workers/scripts/${name}?force=true`));
    console.log(`  deleted worker ${name}`);
    return true;
  } catch (err) {
    if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 404) {
      return false;
    }
    throw err;
  }
}

// --- wrangler ----------------------------------------------------------------

export function wrangler(args: string[], opts: { input?: string } = {}): string {
  const res = spawnSync('bunx', ['wrangler', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
    // CI=true keeps wrangler non-interactive (e.g. `d1 migrations apply`).
    env: { ...process.env, CI: 'true' },
  });
  if (res.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

// --- generated wrangler configs ----------------------------------------------

/** Crude single-value TOML lookup, same approach as seed-sample-comp.ts. */
function tomlValue(toml: string, key: string): string | undefined {
  return toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];
}

function tomlStringArray(toml: string, key: string): string[] {
  const raw = toml.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'))?.[1] ?? '';
  return [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** All `KEY = "value"` pairs inside the `[vars]` section. */
function tomlVars(toml: string): Record<string, string> {
  const block = toml.match(/^\[vars\]([\s\S]*?)(?=^\[|\n*$(?![\s\S]))/m)?.[1] ?? '';
  const vars: Record<string, string> = {};
  for (const m of block.matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)) {
    vars[m[1]] = m[2];
  }
  return vars;
}

/** `preview_id` of the first `[[kv_namespaces]]` block. */
function tomlKvPreviewId(toml: string): string | undefined {
  const block = toml.match(/\[\[kv_namespaces\]\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';
  return block.match(/preview_id\s*=\s*"([^"]+)"/)?.[1];
}

function readWorkerToml(worker: string): string {
  return readFileSync(join(REPO_ROOT, `web/workers/${worker}/wrangler.toml`), 'utf-8');
}

function writeConfig(worker: string, config: Record<string, unknown>): string {
  const path = join(REPO_ROOT, `web/workers/${worker}/wrangler.preview.json`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export interface GeneratedConfigs {
  authConfig: string;
  compConfig: string;
  airscoreConfig: string;
}

/**
 * Write the three wrangler.preview.json configs for a stack. Compatibility
 * settings, vars and KV preview ids are copied from the checked-in TOMLs so a
 * change there flows into previews automatically; names, data bindings and
 * service bindings are the per-branch parts. None declare routes, so a deploy
 * can never attach to glidecomp.com.
 */
export function generateStackConfigs(names: StackNames, d1Id: string): GeneratedConfigs {
  const authToml = readWorkerToml('auth-api');
  const compToml = readWorkerToml('competition-api');
  const airToml = readWorkerToml('airscore-api');

  const d1 = (binding: string) => [
    {
      binding,
      database_name: names.resource,
      database_id: d1Id,
      migrations_dir: '../../db/migrations',
    },
  ];
  const r2 = [{ binding: 'R2', bucket_name: names.resource }];
  const compat = (toml: string) => ({
    compatibility_date: tomlValue(toml, 'compatibility_date'),
    ...(tomlStringArray(toml, 'compatibility_flags').length > 0
      ? { compatibility_flags: tomlStringArray(toml, 'compatibility_flags') }
      : {}),
  });

  const authConfig = writeConfig('auth-api', {
    name: names.authWorker,
    main: 'src/index.ts',
    ...compat(authToml),
    workers_dev: true,
    d1_databases: d1('glidecomp_auth'),
    r2_buckets: r2,
    vars: {
      ...tomlVars(authToml),
      // The stack's public origin — better-auth base URL and cookie context.
      BETTER_AUTH_URL: names.aliasUrl,
      // Previews use the dev-login flow instead of Google OAuth (a per-branch
      // hostname can't be a registered OAuth redirect URI). Dummy Google creds
      // keep better-auth's provider config satisfied; the buttons that would
      // use them are replaced by the test-login path.
      ENABLE_TEST_LOGIN: '1',
      GOOGLE_CLIENT_ID: 'preview-dummy',
      GOOGLE_CLIENT_SECRET: 'preview-dummy',
    },
  });

  const compConfig = writeConfig('competition-api', {
    name: names.compWorker,
    main: 'src/index.ts',
    ...compat(compToml),
    workers_dev: true,
    placement: { mode: 'smart' },
    d1_databases: d1('DB'),
    r2_buckets: r2,
    services: [
      { binding: 'AUTH_API', service: names.authWorker },
      { binding: 'AIRSCORE_API', service: SHARED_AIRSCORE_WORKER },
    ],
    vars: tomlVars(compToml),
    kv_namespaces: [
      // The existing "preview" KV twin, shared by all stacks. Safe: the 3dvis
      // cache key hashes each track's uploaded_at (stamped at seed time), so
      // two branches never collide on a key.
      { binding: 'glidecomp_scores_cache', id: tomlKvPreviewId(compToml) },
    ],
  });

  const airscoreConfig = writeConfig('airscore-api', {
    name: SHARED_AIRSCORE_WORKER,
    main: 'src/index.ts',
    ...compat(airToml),
    workers_dev: true,
    kv_namespaces: [{ binding: 'AIRSCORE_CACHE', id: tomlKvPreviewId(airToml) }],
    vars: tomlVars(airToml),
  });

  return { authConfig, compConfig, airscoreConfig };
}

// --- generated Pages Functions routing module ---------------------------------

const PREVIEW_BACKENDS_PATH = 'functions/lib/preview-backends.ts';

/**
 * Point the Pages Functions at this stack's workers. Overwrites the checked-in
 * module (whose committed state is `null` = production service bindings); CI
 * rewrites it after deploying the workers and before `wrangler pages deploy`,
 * so the branch's Functions bundle carries its own backend URLs.
 */
export function writePreviewBackends(authApiUrl: string, compApiUrl: string): void {
  const path = join(REPO_ROOT, PREVIEW_BACKENDS_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `// GENERATED by web/scripts/preview/deploy-stack.ts for a branch preview deploy.
// Do not commit a non-null version: the committed state must stay null so
// production Pages deployments keep using the service bindings.
import type { PreviewBackends } from "./preview-backends-types";
export type { PreviewBackends } from "./preview-backends-types";

export const previewBackends: PreviewBackends | null = {
  authApiUrl: ${JSON.stringify(authApiUrl)},
  compApiUrl: ${JSON.stringify(compApiUrl)},
};
`,
  );
  console.log(`  wrote ${PREVIEW_BACKENDS_PATH} → ${compApiUrl}`);
}

// --- destroy ------------------------------------------------------------------

/** Tear down one branch's stack. Idempotent; missing pieces are skipped. */
export async function destroyStack(slug: string): Promise<void> {
  const names = stackNames(slug); // slug is already slugged; branchSlug is idempotent
  console.log(`Destroying preview stack "${names.slug}"…`);
  let removed = 0;
  for (const worker of [names.authWorker, names.compWorker]) {
    if (await deleteWorkerScript(worker)) removed++;
  }
  if (await deleteD1(names.resource)) removed++;
  if (await deleteR2Bucket(names.resource)) removed++;
  console.log(removed === 0 ? '  nothing to remove' : `  removed ${removed} resources`);
}

// --- CI output helper ----------------------------------------------------------

export function githubOutput(values: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  if (file) appendFileSync(file, `${lines}\n`);
  console.log(`\n${lines}`);
}
