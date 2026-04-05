/**
 * Seeds a test competition based on the Corryong Cup 2026 Task 1 sample data.
 *
 * Prerequisites:
 *   - `bun run dev` running (auth-api on :8788, competition-api on :8789)
 *   - Logged in via the browser (need a valid session cookie)
 *
 * Usage:
 *   bun web/scripts/seed-corryong-cup.ts <session-cookie>
 *
 * The session cookie can be copied from the browser dev tools:
 *   Application → Cookies → localhost → "better-auth.session_token"
 */

import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const COMP_API = "http://localhost:8789";
const AUTH_API = "http://localhost:8788";
const SAMPLES_DIR = resolve(import.meta.dir, "../samples/comps/corryong-cup-2026-t1");

const sessionCookie = process.argv[2];
if (!sessionCookie) {
  console.error("Usage: bun web/scripts/seed-corryong-cup.ts <session-cookie>");
  console.error("\nCopy the 'better-auth.session_token' cookie from your browser dev tools.");
  process.exit(1);
}

const cookie = `better-auth.session_token=${sessionCookie}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${COMP_API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

// ── Verify auth ──────────────────────────────────────────────────────────────

const meRes = await fetch(`${AUTH_API}/api/auth/me`, {
  headers: { Cookie: cookie },
});
const meData = (await meRes.json()) as { user: { name: string; id: string } | null };
if (!meData.user) {
  console.error("Not authenticated. Check your session cookie.");
  process.exit(1);
}
console.log(`Authenticated as: ${meData.user.name}`);

// ── Read sample data ─────────────────────────────────────────────────────────

const taskXctsk = readFileSync(resolve(SAMPLES_DIR, "task.xctsk"), "utf-8");

const igcFiles = readdirSync(SAMPLES_DIR)
  .filter((f) => f.endsWith(".igc"))
  .sort()
  .map((filename) => {
    const parts = filename.replace(".igc", "").split("_");
    // "van_der_leeden_85053_050126.igc" — CIVL ID is second-to-last, date is last
    const date = parts.pop()!;
    const civlId = parts.pop()!;
    const pilotName = parts
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
    return { filename, pilotName, civlId, date };
  });

console.log(`Found ${igcFiles.length} IGC files`);

// ── Create competition via API ───────────────────────────────────────────────

const comp = (await api("POST", "/api/comp", {
  name: "Corryong Cup 2026",
  category: "hg",
  test: true,
  pilot_classes: ["open", "sport"],
  default_pilot_class: "open",
})) as { comp_id: string };

console.log(`Created competition: ${comp.comp_id}`);

// ── Seed task and pilots directly via D1 ─────────────────────────────────────
// Task and pilot registration routes don't exist yet (iteration 2+),
// so we seed via SQL. D1 doesn't enforce FKs by default, so we can
// insert comp_pilot rows with a stub pilot_id.

const statements: string[] = [];

// Insert task linked to the comp
statements.push(
  `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
   SELECT comp_id, 'Task 1 - Corryong Valley', '2026-01-05', datetime('now'),
          '${esc(taskXctsk)}'
   FROM comp WHERE name = 'Corryong Cup 2026' LIMIT 1;`
);

// Link task to both pilot classes
for (const cls of ["open", "sport"]) {
  statements.push(
    `INSERT INTO task_class (task_id, pilot_class)
     SELECT task_id, '${cls}' FROM task WHERE name = 'Task 1 - Corryong Valley';`
  );
}

// Register pilots in the comp (no user/pilot account needed)
for (let i = 0; i < igcFiles.length; i++) {
  const igc = igcFiles[i];
  const pilotClass = i < igcFiles.length / 2 ? "open" : "sport";

  // Register in competition with organizer-provided details
  statements.push(
    `INSERT INTO comp_pilot (comp_id, registered_pilot_name, registered_pilot_civl_id, pilot_class)
     SELECT comp_id, '${esc(igc.pilotName)}', '${esc(igc.civlId)}', '${pilotClass}'
     FROM comp WHERE name = 'Corryong Cup 2026' LIMIT 1;`
  );
}

// Link IGC tracks to pilots via task_track
for (let i = 0; i < igcFiles.length; i++) {
  const igc = igcFiles[i];
  statements.push(
    `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size)
     SELECT t.task_id, cp.comp_pilot_id, '${esc(igc.filename)}', datetime('now'),
            ${readFileSync(resolve(SAMPLES_DIR, igc.filename)).length}
     FROM task t, comp_pilot cp
     WHERE t.name = 'Task 1 - Corryong Valley'
       AND cp.registered_pilot_civl_id = '${esc(igc.civlId)}';`
  );
}

const sql = statements.join("\n\n");
const tmpFile = `${process.env.TMPDIR || "/tmp"}/seed-corryong-cup.sql`;
await Bun.write(tmpFile, sql);

console.log(`Seeding ${igcFiles.length} pilots, 1 task, and ${igcFiles.length} tracks via D1...`);

const proc = Bun.spawn(
  [
    "wrangler", "d1", "execute", "taskscore-auth",
    "--local",
    "--persist-to", "../../.wrangler/state",
    "--file", tmpFile,
  ],
  {
    cwd: resolve(import.meta.dir, "../workers/competition-api"),
    stdout: "inherit",
    stderr: "inherit",
  }
);
await proc.exited;

if (proc.exitCode === 0) {
  console.log(`\nDone! Corryong Cup 2026 seeded with:`);
  console.log(`  - 1 competition (${comp.comp_id})`);
  console.log(`  - 1 task (Task 1 - Corryong Valley, 2026-01-05)`);
  console.log(`  - ${igcFiles.length} pilots (${Math.floor(igcFiles.length / 2)} open, ${igcFiles.length - Math.floor(igcFiles.length / 2)} sport)`);
  console.log(`  - ${igcFiles.length} track references`);
} else {
  console.error(`\nwrangler d1 execute failed with exit code ${proc.exitCode}`);
  process.exit(1);
}
