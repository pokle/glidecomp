/**
 * A competition flying TODAY on the local workers, for trying the submit
 * sheet (stage 5) and running `.maestro/submit.yaml`. The bundled sample comps
 * are dated to match their tracklogs, so none of them is open for submissions.
 *
 *   bun run --cwd mobile seed:submit            # against http://localhost:8790
 *   API=http://localhost:8890 bun scripts/seed-submit-comp.ts
 *
 * It creates "Submit Test <date>", organised by mobile-organiser@test.local
 * (sign in as that account to submit on a pilot's behalf), with yesterday's and
 * today's task on the Unungra route, and a roster of two:
 *
 * - Sam Submit — CIVL 77001, sam-submit@test.local: the anonymous path.
 * - Alex Unclaimed — alex-unclaimed@test.local: an entry nobody has claimed,
 *   so any OTHER signed-in pilot is asked "which registration are you?".
 *
 * Then it forges a tracklog that flies today's task (`bun run forge-igc`,
 * verified against the scoring engine), writes it to `scripts/out/today.igc`
 * (gitignored), and puts a copy where each booted simulator's file picker
 * looks: Files → On My iPhone, and Android's Downloads.
 * Local data only: the dev-login route exists only on the local workers.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = (process.env.API ?? 'http://localhost:8790').replace(/\/$/, '');
const ROOT = join(import.meta.dir, '..', '..');
const SAMPLE = join(ROOT, 'web/samples/comps/unungra-cup-2020-open-t4/task.xctsk');
/** The comp's organiser: a dev-login account of its own, made on first use. */
const ORGANISER = { name: 'Morgan Organiser', email: 'mobile-organiser@test.local' };

let cookie = '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  const token = setCookie?.match(/better-auth\.session_token=([^;]+)/)?.[1];
  if (token) cookie = `better-auth.session_token=${token}`;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

await call('POST', '/api/auth/dev-login', ORGANISER);

const name = `Submit Test ${day(0)}`;
const { comp_id: compId } = await call<{ comp_id: string }>('POST', '/api/comp', {
  name,
  category: 'hg',
  pilot_classes: ['open'],
});
const xctsk = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const taskIds: string[] = [];
for (const [taskName, date] of [
  ["Yesterday's Task", day(-1)],
  ["Today's Task", day(0)],
] as const) {
  const { task_id } = await call<{ task_id: string }>('POST', `/api/comp/${compId}/task`, {
    name: taskName,
    task_date: date,
    pilot_classes: ['open'],
  });
  await call('PATCH', `/api/comp/${compId}/task/${task_id}`, { xctsk });
  taskIds.push(task_id);
}
for (const pilot of [
  {
    registered_pilot_name: 'Sam Submit',
    pilot_class: 'open',
    registered_pilot_civl_id: '77001',
    registered_pilot_email: 'sam-submit@test.local',
  },
  { registered_pilot_name: 'Alex Unclaimed', pilot_class: 'open', registered_pilot_email: 'alex-unclaimed@test.local' },
]) {
  await call('POST', `/api/comp/${compId}/pilot`, pilot);
}

const out = join(import.meta.dir, 'out');
mkdirSync(out, { recursive: true });
const forged = spawnSync('bun', ['web/scripts/forge-igc.ts', '--task', taskIds[1], '--out', join(out, 'today.igc')], {
  cwd: ROOT,
  env: { ...process.env, DEV_API_ORIGIN: API },
  stdio: ['ignore', 'ignore', 'inherit'],
});
if (forged.status !== 0) throw new Error('forge-igc failed');

// Best effort: a device that is not booted simply does not get a copy.
const igc = join(out, 'today.igc');
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });
const groups = sh('xcrun', ['simctl', 'get_app_container', 'booted', 'com.apple.DocumentsApp', 'groups']);
const localStorage = groups.stdout?.match(/group\.com\.apple\.FileProvider\.LocalStorage\s+(.+)/)?.[1]?.trim();
if (localStorage) {
  sh('cp', [igc, join(localStorage, 'File Provider Storage', 'today.igc')]);
  console.error('Copied to the iOS simulator: Files → On My iPhone → today.igc');
}
if (sh('adb', ['get-state']).stdout?.trim() === 'device') {
  sh('adb', ['push', igc, '/sdcard/Download/today.igc']);
  sh('adb', ['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file:///sdcard/Download/today.igc']);
  console.error('Copied to the Android emulator: Downloads → today.igc');
}

console.log(JSON.stringify({ compId, compName: name, yesterdayTaskId: taskIds[0], todayTaskId: taskIds[1], igc }, null, 2));
