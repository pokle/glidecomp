#!/usr/bin/env bun
// Drives the running GlideComp app in a headless browser to prove it works
// end-to-end: loads a competition and its open-distance scores, screenshots
// both, and asserts the scores table actually rendered rows.
//
// Prereq: the dev stack must already be running (`bun run dev`) and the
// sample comp seeded (`bun run seed:sample big-chip`). See SKILL.md.
//
// Usage:
//   bun .claude/skills/run-glidecomp/driver.mjs               # auto-find "Big Chip" comp
//   BASE_URL=http://localhost:3000 bun .../driver.mjs         # override base URL
//   COMP_MATCH="Corryong" bun .../driver.mjs                  # drive a different comp
//
// Env:
//   BASE_URL   frontend origin (default http://localhost:3000)
//   COMP_MATCH substring to match a comp name (default "Big Chip")
//   OUT_DIR    where screenshots land (default <skill>/shots)

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const MATCH = process.env.COMP_MATCH ?? 'Big Chip';
const OUT = process.env.OUT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(OUT, { recursive: true });

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

// 1. Resolve the comp's public id from the API (sqid changes per seed).
const res = await fetch(`${BASE}/api/comp`).catch((e) => die(`GET /api/comp failed — is \`bun run dev\` up? ${e}`));
if (!res.ok) die(`GET /api/comp → HTTP ${res.status}`);
const { comps } = await res.json();
const comp = comps?.find((c) => c.name.includes(MATCH));
if (!comp) die(`no comp matching "${MATCH}" — seed it first: bun run seed:sample big-chip`);
console.log(`→ comp "${comp.name}" id=${comp.comp_id} scoring=${comp.scoring_format}`);

const browser = await chromium.launch(); // headless
const page = await browser.newPage({ viewport: { width: 1280, height: 2400 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// 2. Comp detail page.
await page.goto(`${BASE}/comp/${comp.comp_id}`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: comp.name, level: 1 }).waitFor({ timeout: 10_000 });
const pilotCount = await page.locator('table tbody tr').count();
await page.screenshot({ path: join(OUT, 'comp.png'), fullPage: true });
console.log(`→ comp page rendered, ${pilotCount} pilot rows → shots/comp.png`);

// 3. Scores page — the real end-to-end payoff (client-side open-distance scoring).
await page.goto(`${BASE}/scores?comp_id=${comp.comp_id}`, { waitUntil: 'networkidle' });
await page.locator('table tbody tr').first().waitFor({ timeout: 15_000 });
const rows = await page.locator('table tbody tr').count();
if (rows < 1) die('scores table rendered no rows');
const top = (await page.locator('table tbody tr').first().innerText()).replace(/\s+/g, ' ').trim();
const last = (await page.locator('table tbody tr').last().innerText()).replace(/\s+/g, ' ').trim();
await page.screenshot({ path: join(OUT, 'scores.png'), fullPage: true });
console.log(`→ scores page rendered, ${rows} rows → shots/scores.png`);
console.log(`   winner: ${top}`);
console.log(`   last:   ${last}`);

await browser.close();
if (errors.length) die(`console errors on page:\n  ${errors.join('\n  ')}`);
console.log(`✓ drove ${comp.name} end-to-end — comp + scores rendered, no console errors`);
