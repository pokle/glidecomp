#!/usr/bin/env bun
/**
 * Has any standard GlideComp follows moved since we last looked?
 *
 * The register is docs/standards/registry.json: every external spec, format or
 * protocol the code claims to follow, the edition it follows, where that lives
 * in the tree, and how to tell whether the source has moved. This script does
 * the mechanical half of the monthly standards routine
 * (.claude/commands/standards-check.md): it fetches each source, works out the
 * version (or a fingerprint of the text when the source has no version), and
 * reports what is new. Deciding what a change MEANS — major or minor, safe to
 * PR or one for the owner — is the routine's job, not this script's.
 *
 * Check kinds (`check.kind` in the register):
 *   regex       fetch `url`, take capture group 1 of `pattern` as the version
 *   redirect    follow `url`'s redirects; `pattern` on the FINAL URL gives it
 *               (MCP publishes /specification/latest → /specification/<rev>)
 *   same-as     fetch `url` and compare it with the vendored copy at `local`;
 *               any difference means the copy is stale
 *   hash        fingerprint the text of `url` (optionally the part between
 *               `from` and `to`) and compare with the last fingerprint seen.
 *               The text itself is kept in docs/standards/snapshots/<id>.txt,
 *               so a change can be READ, not just detected: the report gives
 *               the `diff` command between that snapshot and today's text
 *   research    no reliable machine source (fai.org refuses scripted fetches,
 *               and its PDF names change per edition): the routine searches
 *
 * Usage:
 *   bun web/scripts/standards-check.ts            print the report
 *   bun web/scripts/standards-check.ts --json     the report as JSON
 *   bun web/scripts/standards-check.ts --record   also write what was seen back
 *                                                 into the register, and refresh
 *                                                 the snapshots (run after the
 *                                                 findings are dealt with). An
 *                                                 entry is touched only when what
 *                                                 was seen changed, so a quiet
 *                                                 month leaves no diff
 *
 * Today's text for every fingerprinted source is written to $STANDARDS_OUT
 * (default: <tmpdir>/standards-check/<id>.txt) whether or not --record is given.
 *
 * Never fails on a finding: it is a report, and an unreachable source is a
 * finding like any other (status "unreachable"), not a crash.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
export const REGISTER = join(ROOT, 'docs', 'standards', 'registry.json');
const SNAPSHOTS = join(ROOT, 'docs', 'standards', 'snapshots');
const OUT = process.env.STANDARDS_OUT ?? join(tmpdir(), 'standards-check');

export type Check =
  | { kind: 'regex'; url: string; pattern: string }
  | { kind: 'redirect'; url: string; pattern: string }
  | { kind: 'same-as'; url: string; local: string }
  | { kind: 'hash'; url: string; from?: string; to?: string }
  | { kind: 'research'; queries: string[] }; // {year} and {next} are filled in

export interface Standard {
  id: string;
  name: string;
  /** The edition/version/revision GlideComp implements, as the tree states it. */
  follows: string;
  /** Where that is stated, and where it is implemented and tested. */
  statedIn: string[];
  implementedIn: string[];
  testedIn?: string[];
  check: Check;
  /** What a change to this standard requires here; read by the routine. */
  onChange: string;
  /** What the last run saw, so "new since last check" can be told apart from "known and deliberately not adopted". */
  seen?: { value: string; checkedAt: string; note?: string };
}

export type Status =
  | 'current' // the source matches what we follow (or the vendored copy)
  | 'new' // the source has moved since the last recorded check
  | 'behind' // the source differs from what we follow, but the last run already saw it
  | 'unreachable'
  | 'research';

export interface Finding {
  id: string;
  name: string;
  follows: string;
  latest: string | null;
  status: Status;
  change?: 'major' | 'minor' | 'revision' | 'content';
  detail?: string;
}

/** Collapse whitespace and line endings, so a re-wrapped page isn't a "change". */
export function normalise(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

/** The text of an HTML page, near enough to fingerprint: tags, scripts and styles out. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function fingerprint(text: string): string {
  return createHash('sha256').update(normalise(text)).digest('hex').slice(0, 16);
}

/** Capture group 1 of `pattern`, or null when it doesn't match. An empty capture reads "none" — an RFC's empty `obsoleted_by` list is a real answer. */
export function extract(text: string, pattern: string): string | null {
  const m = new RegExp(pattern, 'i').exec(text);
  if (!m) return null;
  return (m[1] ?? '').trim() || 'none';
}

/** The part of `text` between the first match of `from` and the next match of `to`. */
export function slice(text: string, from?: string, to?: string): string {
  let start = 0;
  if (from) {
    const m = new RegExp(from, 'i').exec(text);
    if (!m) return text;
    start = m.index;
  }
  if (!to) return text.slice(start);
  const rest = text.slice(start + 1);
  const end = new RegExp(to, 'i').exec(rest);
  return end ? text.slice(start, start + 1 + end.index) : text.slice(start);
}

/**
 * How big a version change looks, from the strings alone. A guide for the
 * routine, which reads the actual changelog before deciding anything:
 * - two dates (MCP's 2025-11-25 → 2026-07-28): a new protocol revision;
 * - an edition year changing (S7F "2026 V1.0" → "2027 V1.0"): major;
 * - otherwise the first number that differs decides: the first → major, a
 *   later one → minor ("v0.91" → "v0.92" minor, "1.0" → "2.0" major).
 */
export function classify(from: string, to: string): 'major' | 'minor' | 'revision' {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (date.test(from) && date.test(to)) return 'revision';
  const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const a = nums(from);
  const b = nums(to);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return i === 0 ? 'major' : 'minor';
  }
  return 'minor';
}

/** A research query with {year} and {next} filled in, so "the next edition" searches for an actual year. */
export function withYear(query: string, now = new Date()): string {
  const year = now.getUTCFullYear();
  return query.replaceAll('{year}', String(year)).replaceAll('{next}', String(year + 1));
}

/** The status of one standard, given what the source says now. Pure, for the tests. */
export function judge(std: Standard, latest: string | null, opts: { local?: string } = {}): Finding {
  const base = { id: std.id, name: std.name, follows: std.follows, latest };
  const check = std.check;
  if (check.kind === 'research') {
    return { ...base, status: 'research', detail: `Search: ${check.queries.map((q) => withYear(q)).join(' | ')}` };
  }
  if (latest === null) return { ...base, status: 'unreachable' };
  const seenBefore = std.seen?.value === latest;

  if (check.kind === 'same-as') {
    if (opts.local !== undefined && fingerprint(opts.local) === latest) return { ...base, status: 'current' };
    return {
      ...base,
      status: seenBefore ? 'behind' : 'new',
      change: 'content',
      detail: `upstream differs from ${check.local}`,
    };
  }
  if (check.kind === 'hash') {
    if (!std.seen) return { ...base, status: 'new', change: 'content', detail: 'no fingerprint recorded yet' };
    return seenBefore ? { ...base, status: 'current' } : { ...base, status: 'new', change: 'content' };
  }
  // regex / redirect: a version string.
  if (latest === std.follows) return { ...base, status: 'current' };
  return { ...base, status: seenBefore ? 'behind' : 'new', change: classify(std.follows, latest) };
}

const UA = 'GlideComp standards check (+https://glidecomp.com; github.com/pokle/glidecomp)';

async function fetchText(url: string): Promise<{ text: string; finalUrl: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { text: await res.text(), finalUrl: res.url };
  } catch (err) {
    return { error: String(err) };
  }
}

/** What the source says now: a version, or a fingerprint (with the text it was taken over). Null, with a reason, when it can't be read. */
export async function look(
  std: Standard
): Promise<{ latest: string | null; error?: string; local?: string; text?: string }> {
  const check = std.check;
  if (check.kind === 'research') return { latest: null };
  const got = await fetchText(check.url);
  if ('error' in got) return { latest: null, error: got.error };
  switch (check.kind) {
    case 'regex': {
      const v = extract(got.text, check.pattern);
      return v ? { latest: v } : { latest: null, error: `pattern ${check.pattern} not found` };
    }
    case 'redirect': {
      const v = extract(got.finalUrl, check.pattern);
      return v ? { latest: v } : { latest: null, error: `pattern not in final URL ${got.finalUrl}` };
    }
    case 'same-as': {
      let local: string | undefined;
      try {
        local = readFileSync(join(ROOT, check.local), 'utf8');
      } catch {
        local = undefined;
      }
      return { latest: fingerprint(got.text), local };
    }
    case 'hash': {
      const looksHtml = /<html|<body|<div/i.test(got.text);
      const text = normalise(slice(looksHtml ? htmlText(got.text) : got.text, check.from, check.to));
      return { latest: fingerprint(text), text };
    }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const register = JSON.parse(readFileSync(REGISTER, 'utf8')) as { standards: Standard[] } & Record<string, unknown>;
  const findings: Finding[] = [];

  mkdirSync(OUT, { recursive: true });
  for (const std of register.standards) {
    const seen = await look(std);
    const finding = judge(std, seen.latest, { local: seen.local });
    if (seen.error) finding.detail = [finding.detail, seen.error].filter(Boolean).join('; ');
    if (seen.text !== undefined) {
      const now = join(OUT, `${std.id}.txt`);
      const kept = join(SNAPSHOTS, `${std.id}.txt`);
      writeFileSync(now, `${seen.text}\n`);
      if (finding.status === 'new' && existsSync(kept)) {
        finding.detail = [finding.detail, `diff ${relative(ROOT, kept)} ${now}`].filter(Boolean).join('; ');
      }
      if (args.has('--record')) {
        mkdirSync(SNAPSHOTS, { recursive: true });
        writeFileSync(kept, `${seen.text}\n`);
      }
    }
    findings.push(finding);
    // Only a CHANGE is recorded, so a quiet month leaves the register alone.
    if (args.has('--record') && seen.latest !== null && std.seen?.value !== seen.latest) {
      std.seen = { value: seen.latest, checkedAt: today() };
    }
  }

  if (args.has('--record')) writeFileSync(REGISTER, `${JSON.stringify(register, null, 2)}\n`);

  if (args.has('--json')) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }
  const order: Status[] = ['new', 'behind', 'unreachable', 'research', 'current'];
  findings.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  console.log('| Standard | Follows | Latest | Status | Detail |');
  console.log('|---|---|---|---|---|');
  for (const f of findings) {
    const status = f.change ? `${f.status} (${f.change})` : f.status;
    console.log(`| ${f.name} | ${f.follows} | ${f.latest ?? '—'} | ${status} | ${f.detail ?? ''} |`);
  }
}

if (import.meta.main) await main();
