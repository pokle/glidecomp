/**
 * docs/api.md must name EVERY endpoint, not just the ones with worked examples.
 *
 * The sibling guard, e2e/api-doc.spec.ts, executes each `curl` example in the
 * doc against a live stack — so the examples cannot rot. But an example is only
 * possible for an endpoint that is safe to call: a DELETE, an admin action or
 * anything needing an id the harness never learns has no example, and before
 * this test nothing noticed when such an endpoint was added, renamed or removed.
 *
 * So the doc carries a reference TABLE row for every endpoint, in the canonical
 * `:param` form, and this test is what keeps those tables honest. It is a pure
 * source-to-source comparison — no server, no build — so it runs in `bun test`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const API_DOC = join(ROOT, 'docs', 'api.md');

/** Every .ts under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

export interface Endpoint {
  method: string;
  path: string;
  /** Where it is defined, for the failure message. */
  source: string;
}

/**
 * Hono route declarations across every Worker.
 *
 * The verb and its path literal are often separated by an explanatory comment
 * (`.get(\n  // mounted ahead of compRoutes\n  "/api/comp/search"`), so the gap
 * between them has to tolerate comments as well as whitespace — matching on
 * `.get("` alone silently misses four route files.
 */
export function workerEndpoints(): Endpoint[] {
  const gap = String.raw`(?:\s|//[^\n]*\n|/\*[\s\S]*?\*/)*`;
  const re = new RegExp(
    String.raw`\.(get|post|put|patch|delete|all)\(` + gap + String.raw`(?:"([^"]+)"|'([^']+)')`,
    'g'
  );
  const found = new Map<string, Endpoint>();
  for (const file of walk(join(ROOT, 'web', 'workers'))) {
    const rel = relative(ROOT, file);
    if (!rel.includes('/src/') || rel.includes('test')) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const path = m[2] ?? m[3];
      if (!path.startsWith('/api/') && !path.startsWith('/internal/')) continue;
      const key = `${m[1].toUpperCase()} ${path}`;
      if (!found.has(key)) found.set(key, { method: m[1].toUpperCase(), path, source: rel });
    }
  }
  return [...found.values()];
}

/**
 * Endpoints served by Pages Functions rather than a Worker.
 *
 * These are a contract too — `/sitemap.xml` is read by crawlers and
 * `scores.csv` is a documented download — but they are files-as-routes, not
 * Hono declarations, so they are enumerated rather than parsed. The
 * `functions/api/**` files are pass-through proxies to the Workers above and
 * are deliberately NOT listed: they add no endpoint of their own.
 */
export const PAGES_FUNCTION_ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/sitemap.xml', source: 'functions/sitemap.xml.ts' },
  { method: 'GET', path: '/civl-rankings.csv', source: 'functions/civl-rankings.csv.ts' },
  { method: 'GET', path: '/comp/:comp_id/scores.csv', source: 'functions/comp/[[path]].ts' },
];

/**
 * The `METHOD /path` pairs the doc names, from its reference tables.
 *
 * Table rows read `| `GET` | `/api/comp/:comp_id` | … |`, and one row may carry
 * several verbs for the same path (`GET`, `POST`). Both are picked up here:
 * every backticked METHOD on the row binds to the row's first backticked path.
 */
export function documentedEndpoints(md: string): Set<string> {
  const out = new Set<string>();
  for (const line of md.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const methods = [...line.matchAll(/`(GET|POST|PUT|PATCH|DELETE|ALL)`/g)].map((m) => m[1]);
    if (methods.length === 0) continue;
    const path = line.match(/`(\/(?:api|internal|comp|sitemap|civl)[^`]*)`/)?.[1];
    if (!path) continue;
    for (const m of methods) out.add(`${m} ${path}`);
  }
  return out;
}

describe('docs/api.md endpoint coverage', () => {
  const md = readFileSync(API_DOC, 'utf8');
  const documented = documentedEndpoints(md);
  const all = [...workerEndpoints(), ...PAGES_FUNCTION_ENDPOINTS];

  it('finds the routes it is meant to be checking', () => {
    // A parser that silently matched nothing would make every assertion below
    // vacuously pass, which is the one failure mode this guard cannot afford.
    expect(all.length).toBeGreaterThan(60);
    expect(documented.size).toBeGreaterThan(60);
  });

  it('documents every Worker and Pages Function endpoint', () => {
    const missing = all
      .filter((e) => !documented.has(`${e.method} ${e.path}`))
      .map((e) => `  ${e.method} ${e.path}   (${e.source})`);
    expect(
      missing,
      `docs/api.md is missing ${missing.length} endpoint(s). Add a reference-table ` +
        `row for each, using the canonical :param names:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('documents no endpoint that no longer exists', () => {
    const live = new Set(all.map((e) => `${e.method} ${e.path}`));
    const stale = [...documented].filter((d) => !live.has(d)).map((d) => `  ${d}`);
    expect(
      stale,
      `docs/api.md documents ${stale.length} endpoint(s) that no route defines. ` +
        `Remove the row, or fix its path:\n${stale.join('\n')}`
    ).toEqual([]);
  });
});
