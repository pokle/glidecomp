#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Step 2 of the track-placement experiment (issue #692): fill the archive's
 * `weather/` store with what the sky was doing over each task.
 *
 * It goes through the engine's own providers with a plain `fetch` injected,
 * and derives its query with `weatherQueryForTask` — so this script and the
 * app ask the identical question about a task, and each stored file records
 * the `weatherQueryKey` it answers. A consumer that computes a different key
 * for the same task (the route or the date moved) must refetch rather than
 * silently serve the wrong sky.
 *
 * BOTH datasets are fetched where both are available, rather than letting the
 * registry pick a winner:
 *   era5.json               ERA5 reanalysis — uniform over 2017–2026.
 *   archived-forecast.json  the archived operational forecast — 2022+, and
 *                           the only one carrying pressure-level winds and
 *                           CAPE. It is an ablation arm, so it is stored
 *                           separately rather than merged.
 *
 * The forecast host answers `Daily API request limit exceeded` from a shared
 * cloud proxy IP, which is why this runs from a local machine. It is
 * resumable and never refetches what the store already holds, so a run that
 * hits the limit can simply be started again tomorrow.
 *
 * Nothing here is imported by the app, the engine's scoring closure, or CI.
 *
 * Usage:
 *   bun experiments/track-placement/fetch-weather.ts
 *   bun experiments/track-placement/fetch-weather.ts --provider era5
 *   bun experiments/track-placement/fetch-weather.ts --comp forbes-flatlands-2026
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openMeteoEra5Provider,
  openMeteoHistoricalForecastProvider,
  parseXCTask,
  weatherQueryForTask,
  weatherQueryKey,
  WEATHER_SCHEMA_VERSION,
  type TaskWeather,
  type WeatherFetchFn,
  type WeatherProvider,
  type WeatherQuery,
} from '@glidecomp/engine';
import { ARCHIVE_ROOT, COMPS_ROOT, loadCorpus } from './lib/corpus';

/** Filename per provider — the plan's `<task-dir>/<dataset>.json` layout. */
const DATASETS: { file: string; provider: WeatherProvider }[] = [
  { file: 'era5.json', provider: openMeteoEra5Provider() },
  { file: 'archived-forecast.json', provider: openMeteoHistoricalForecastProvider() },
];

/** One stored answer, with everything needed to check it is still the right one. */
interface StoredWeather {
  schema_version: number;
  /** The key the engine derives for this task. A mismatch means refetch. */
  query_key: string;
  query: WeatherQuery;
  task_dir: string;
  comp: string;
  task_date: string;
  weather: TaskWeather;
}

/** Open-Meteo asks for a courteous request rate; this is well inside it. */
const DEFAULT_DELAY_MS = 300;
const MAX_ATTEMPTS = 3;

class RateLimited extends Error {}

/**
 * The platform `fetch` narrowed to the four members a provider touches.
 *
 * The engine declares its own `WeatherFetchFn` rather than importing DOM or
 * workers types — that purity is what lets the same provider run in the
 * browser, in workerd and here — so the adapter is one line rather than a
 * structural coincidence.
 */
const fetchImpl: WeatherFetchFn = (input, init) =>
  fetch(input, { signal: init?.signal as AbortSignal | undefined });

async function fetchOne(
  query: WeatherQuery,
  provider: WeatherProvider,
): Promise<TaskWeather> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await provider.fetch(query, { fetchImpl, nowMs: Date.now() });
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // A daily quota is not a transient failure — retrying burns the rest of
      // the run's time for nothing. Stop the whole dataset and say so.
      if (/limit exceeded|too many requests|\b429\b/i.test(message)) {
        throw new RateLimited(message);
      }
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Args {
  only: string[];
  out: string;
  force: boolean;
  delayMs: number;
  datasets: typeof DATASETS;
}

function parseArgs(argv: string[]): Args {
  const only: string[] = [];
  let out = ARCHIVE_ROOT;
  let force = false;
  let delayMs = DEFAULT_DELAY_MS;
  let datasets = DATASETS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--comp') only.push(argv[++i]);
    else if (arg === '--out') out = argv[++i];
    else if (arg === '--force') force = true;
    else if (arg === '--delay') delayMs = Number(argv[++i]);
    else if (arg === '--provider') {
      const want = argv[++i];
      const file = want.endsWith('.json') ? want : `${want}.json`;
      datasets = DATASETS.filter((d) => d.file === file);
      if (datasets.length === 0) {
        throw new Error(`Unknown provider "${want}" — try ${DATASETS.map((d) => d.file.replace('.json', '')).join(' or ')}`);
      }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { only, out, force, delayMs, datasets };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus({ only: args.only });
  if (corpus.comps.length === 0) {
    console.error(
      `No comps found.\n  comps:   ${COMPS_ROOT}\n  archive: ${ARCHIVE_ROOT}\n` +
        'Set GLIDECOMP_ARCHIVE_DIR to a checkout of pokle/glidecomp-archive.',
    );
    process.exit(2);
  }

  const weatherRoot = join(args.out, 'weather');
  mkdirSync(weatherRoot, { recursive: true });

  const counts = { fetched: 0, kept: 0, refetched: 0, unsupported: 0, failed: 0, noQuery: 0 };
  const exhausted = new Set<string>();
  const failures: string[] = [];

  const tasks = corpus.comps.flatMap((c) => c.tasks);
  let n = 0;
  for (const entry of tasks) {
    n++;
    if (!entry.date) {
      counts.noQuery++;
      console.log(`[${n}/${tasks.length}] ${entry.dir}: no task date — skipped`);
      continue;
    }
    const task = parseXCTask(readFileSync(join(entry.root, entry.dir, 'task.xctsk'), 'utf-8'));
    // No elevation override: weatherQueryForTask takes the route's own mean
    // turnpoint elevation, which is what the app does too — so the query key
    // this store is written under is the key the app derives.
    const query = weatherQueryForTask(task, entry.date);
    if (!query) {
      counts.noQuery++;
      console.log(`[${n}/${tasks.length}] ${entry.dir}: no weather query — skipped`);
      continue;
    }
    const key = weatherQueryKey(query);
    const dir = join(weatherRoot, entry.dir);

    const notes: string[] = [];
    for (const { file, provider } of args.datasets) {
      if (exhausted.has(provider.id)) continue;
      if (!provider.supports(query)) {
        counts.unsupported++;
        continue;
      }
      const path = join(dir, file);
      if (!args.force && existsSync(path)) {
        const stored = readStored(path);
        // The key is the whole point of storing it: a task whose turnpoints
        // or times changed asks a different question now, and the old answer
        // is the wrong sky rather than a stale one.
        if (stored && stored.query_key === key && stored.schema_version === WEATHER_SCHEMA_VERSION) {
          counts.kept++;
          continue;
        }
        notes.push(`${file}: stored answer is for another query — refetching`);
        counts.refetched++;
      }

      try {
        const weather = await fetchOne(query, provider);
        const payload: StoredWeather = {
          schema_version: WEATHER_SCHEMA_VERSION,
          query_key: key,
          query,
          task_dir: entry.dir,
          comp: entry.compSlug,
          task_date: entry.date,
          weather,
        };
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(payload) + '\n');
        counts.fetched++;
        notes.push(`${file}: ${weather.hours.length}h from ${weather.source.model}`);
        await sleep(args.delayMs);
      } catch (err) {
        if (err instanceof RateLimited) {
          exhausted.add(provider.id);
          console.log(
            `\n  ${provider.id} is rate-limited (${err.message}).\n` +
              '  Stopping that dataset; everything already stored is kept. ' +
              'Re-run later and it resumes.\n',
          );
          continue;
        }
        counts.failed++;
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${entry.dir} ${file}: ${message}`);
        notes.push(`${file}: FAILED — ${message}`);
      }
    }
    console.log(
      `[${n}/${tasks.length}] ${entry.dir}` + (notes.length ? `: ${notes.join('; ')}` : ': up to date'),
    );
    if (exhausted.size === args.datasets.length) {
      console.log('  Every requested dataset is rate-limited — stopping.');
      break;
    }
  }

  writeStoreReadme(weatherRoot);
  console.log(
    `\n${counts.fetched} fetched, ${counts.kept} already stored, ${counts.refetched} refetched ` +
      `(query moved), ${counts.unsupported} not covered by a dataset, ${counts.failed} failed, ` +
      `${counts.noQuery} with no derivable query.`,
  );
  for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
  if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
  if (exhausted.size > 0) {
    console.log(
      `\nRate-limited: ${[...exhausted].join(', ')}. Re-run to resume — nothing already ` +
        'stored is refetched.',
    );
  }
}

function readStored(path: string): StoredWeather | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StoredWeather;
  } catch {
    return null;
  }
}

function writeStoreReadme(weatherRoot: string) {
  writeFileSync(
    join(weatherRoot, 'README.md'),
    `# Task weather

Written by \`experiments/track-placement/fetch-weather.ts\` in
[pokle/glidecomp](https://github.com/pokle/glidecomp). One directory per task
folder, one file per dataset:

| File | Dataset | Era | Carries |
|---|---|---|---|
| \`era5.json\` | ERA5 reanalysis | all | surface wind/gust/temperature/dewpoint, cloud, radiation, boundary layer |
| \`archived-forecast.json\` | archived operational forecast | 2022+ | the above, plus pressure-level winds (950–700 hPa) and CAPE |

Derived data, committed because it is expensive to produce (the forecast host
is rate-limited) and cheap to store — and because the forecast archive is
genuinely perishable.

Each file records the \`weatherQueryKey\` it answers, alongside the query
itself. **Check the key against the one the engine derives for that task
today** (\`weatherQueryForTask\` → \`weatherQueryKey\`): a mismatch means the
task's turnpoints or times moved, and the stored answer is the wrong sky
rather than a stale one. Refetch instead of reading it.

\`schema_version\` is the engine's \`WEATHER_SCHEMA_VERSION\`; a bump rolls
every file here to stale.
`,
  );
}

main();
