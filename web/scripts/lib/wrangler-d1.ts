// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Running SQL against D1 through the wrangler CLI, with the retry policy the
 * seed script learned the hard way.
 *
 * Extracted from `seed-sample-comp.ts`, which still imports it — there must be
 * exactly one answer to "is this wrangler failure worth retrying?", because
 * getting it wrong in either direction is expensive: retrying a UNIQUE
 * violation five times wastes a minute per statement and buries the real
 * error, while NOT retrying a Cloudflare 10001 fails a whole production seed
 * on a hiccup.
 *
 * Two callers with different needs:
 *   * the seed drives hundreds of small statements and so uses an in-process
 *     Miniflare for its local path, keeping only the remote path here;
 *   * `fetch-civl-rankings.ts` issues a handful of large ones and uses the CLI
 *     for local as well as remote, which is why `createD1Client` takes the
 *     target rather than assuming `--remote`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file lives at web/scripts/lib/, so the repo root is three up. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const WRANGLER_MAX_ATTEMPTS = 5;

/** Exponential backoff, capped: 1s, 2s, 4s, 8s, 15s… */
function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}

/**
 * Whether a failed wrangler invocation looks like a transient Cloudflare/network
 * hiccup — a 5xx, a 429, an "internal error" (D1/R2 both surface CF error 10001
 * "We encountered an internal error. Please try again."), or a dropped socket —
 * as opposed to a deterministic failure (bad SQL, a UNIQUE violation) that would
 * fail identically forever. Matched on textual markers rather than a bare status
 * number so a key/path segment like `.../t/500/…` can't masquerade as a 500.
 */
export function isTransientWranglerError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('internal error') ||
    m.includes('internal server error') ||
    m.includes('try again') ||
    m.includes('service unavailable') ||
    m.includes('too many requests') ||
    m.includes('rate limit') ||
    /\b(5\d\d|429)\s*:/.test(m) || // "- 500: Internal Server Error", "429: …"
    /etimedout|econnreset|eai_again|enotfound|socket hang up|fetch failed|network error/.test(m)
  );
}

/** Block the calling thread for `ms` (sync backoff, so the sync D1 path can wait). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function warnRetry(args: string[], attempt: number, msg: string): void {
  const firstLine = (msg.split('\n').find((l) => l.trim()) ?? msg).trim();
  console.warn(
    `  ⚠ wrangler ${args.slice(0, 3).join(' ')} failed (attempt ${attempt}/${WRANGLER_MAX_ATTEMPTS}), ` +
      `retrying in ${backoffMs(attempt) / 1000}s: ${firstLine}`,
  );
}

/** Synchronous wrangler invocation with retries. Returns stdout. */
export function wrangler(args: string[]): string {
  for (let attempt = 1; ; attempt++) {
    const res = spawnSync('bunx', ['wrangler', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status === 0) return res.stdout;
    const msg = res.stderr || res.stdout;
    if (attempt >= WRANGLER_MAX_ATTEMPTS || !isTransientWranglerError(msg)) {
      throw new Error(`wrangler ${args.join(' ')} failed:\n${msg}`);
    }
    warnRetry(args, attempt, msg);
    sleepSync(backoffMs(attempt));
  }
}

/** Async wrangler invocation, so independent calls can run concurrently. */
export async function wranglerAsync(args: string[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise<void>((res, rej) => {
        const child = spawn('bunx', ['wrangler', ...args], { cwd: REPO_ROOT });
        let stderr = '';
        let stdout = '';
        child.stdout?.on('data', (d) => (stdout += d));
        child.stderr?.on('data', (d) => (stderr += d));
        child.on('error', rej);
        child.on('close', (code) =>
          code === 0 ? res() : rej(new Error(`wrangler ${args.join(' ')} failed:\n${stderr || stdout}`)),
        );
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= WRANGLER_MAX_ATTEMPTS || !isTransientWranglerError(msg)) throw err;
      warnRetry(args, attempt, msg);
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
}

/**
 * Extract wrangler's JSON payload from stdout. On `--remote`, wrangler decorates
 * stdout with progress lines ("├ Checking if file needs uploading", spinner
 * frames, "🌀 Uploading …") before the JSON array, so the whole string isn't
 * valid JSON — slice from the first `[`. (Warnings/banners go to stderr, which
 * `wrangler()` discards, so they never reach here.)
 */
export function parseWranglerJson(out: string): Array<{ results: Record<string, unknown>[] }> {
  const start = out.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON found):\n${out}`);
  return JSON.parse(out.slice(start));
}

/** Single-quote a value for SQL, escaping embedded quotes. NULL passes through. */
export function q(v: string | number | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Pull a string value out of a `[[header]]` table in a worker's wrangler.toml
 * (e.g. the D1 `database_id` or the R2 `bucket_name`). Miniflare keys the local
 * D1 sqlite file by the *database_id*, not the name, so anything reading that
 * state must read the very same id wrangler/`bun run dev` use — hardcoding
 * would silently talk to a different file than the app does.
 */
export function tomlValue(configPath: string, header: string, key: string): string {
  const toml = readFileSync(join(REPO_ROOT, configPath), 'utf-8');
  const block = toml.match(new RegExp(`\\[\\[${header}\\]\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1] ?? '';
  const m = block.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
  if (!m) throw new Error(`${configPath}: [[${header}]] ${key} not found`);
  return m[1];
}

/** Where the local dev stack persists its D1/R2 state. */
export const LOCAL_PERSIST = 'web/.wrangler/state';

export interface D1Client {
  /** Run SQL that returns nothing. Written to a temp file, because `--command`
   *  goes through the shell's argument-length cap and a bulk insert blows it. */
  execSql(sql: string): void;
  /** Run one statement and return its rows. Must use `--command`: on
   *  `--remote`, `--file` returns only an execution summary, never results. */
  queryRows(sql: string): Record<string, unknown>[];
}

/**
 * A D1 client over the wrangler CLI.
 *
 * @param configPath worker wrangler.toml to read the binding out of
 * @param remote     true for production D1, false for the local dev state
 */
export function createD1Client(configPath: string, remote: boolean): D1Client {
  const dbName = tomlValue(configPath, 'd1_databases', 'database_name');
  const config = ['--config', configPath];
  const target = remote ? ['--remote'] : ['--local', '--persist-to', LOCAL_PERSIST];
  const scratch = mkdtempSync(join(tmpdir(), 'd1-'));
  let seq = 0;

  return {
    execSql(sql: string): void {
      const file = join(scratch, `q${seq++}.sql`);
      writeFileSync(file, sql);
      wrangler(['d1', 'execute', dbName, ...config, ...target, '--json', '--file', file]);
    },
    queryRows(sql: string): Record<string, unknown>[] {
      const out = wrangler([
        'd1', 'execute', dbName, ...config, ...target, '--json', '--command', sql,
      ]);
      return parseWranglerJson(out)[0]?.results ?? [];
    },
  };
}
