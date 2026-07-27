/**
 * Runs once before the suite, after the webServers are up (Playwright starts
 * its webServer plugins before globalSetup).
 *
 * Local D1 state is *persistent* — `web/.wrangler/state` survives every run —
 * so a spec that creates a comp and doesn't remove it leaves it there forever.
 * Issue #477: that accumulation is what made the suite flake locally (worse
 * every run, blamed on whatever code was in flight) and what silently broke SSR
 * discovery once an "API Doc Comp" sorted ahead of the seeded fixture.
 *
 * Specs clean up after themselves now. This is the net under that: a run killed
 * with ^C, or a spec that fails between create and delete, still leaves rows
 * behind. Sweeping them here means a dirty database is self-healing instead of
 * needing someone to know about `bun run kill-state`.
 *
 * Deliberately narrow: it only removes comps whose names carry an e2e prefix
 * (fixtures/stack.ts). The seeded sample comps are never touched — reseeding
 * those is slow, and a globalSetup that wipes them would make every local run
 * expensive.
 */
import { request } from "@playwright/test";
import {
  API_URL,
  SUPER_ADMIN,
  isE2ECreatedComp,
  E2E_COMP_PREFIXES,
} from "./fixtures/stack";

interface CompRow {
  comp_id: string;
  name: string;
}

export default async function globalSetup(): Promise<void> {
  const api = await request.newContext({ baseURL: API_URL });
  try {
    // The super admin sees (and administers) every comp, including hidden
    // `test` ones — which is what a leaked comp-creation.spec.ts comp is.
    const login = await api.post("/api/auth/dev-login", { data: SUPER_ADMIN });
    if (!login.ok()) {
      console.warn(
        `[e2e] leftover sweep skipped: dev-login failed (${login.status()}). ` +
          `Stale e2e comps may still be in web/.wrangler/state — ` +
          `\`bun run kill-state\` clears everything.`
      );
      return;
    }
    const cookie = login
      .headers()
      ["set-cookie"]?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) return;

    const listed = await api.get("/api/comp", { headers: { cookie } });
    if (!listed.ok()) return;
    const { comps } = (await listed.json()) as { comps: CompRow[] };

    const stale = comps.filter((c) => isE2ECreatedComp(c.name));
    if (stale.length === 0) return;

    console.log(
      `[e2e] sweeping ${stale.length} leftover comp(s) from previous runs ` +
        `(names starting ${E2E_COMP_PREFIXES.map((p) => `"${p}"`).join(" or ")})`
    );
    for (const comp of stale) {
      const res = await api.delete(`/api/comp/${comp.comp_id}`, {
        headers: { cookie },
      });
      if (!res.ok()) {
        console.warn(`[e2e]   could not delete "${comp.name}": ${res.status()}`);
      }
    }
  } catch (err) {
    // Never fail the run over cleanup — a sweep that can't run is a hygiene
    // problem, not a test result.
    console.warn(`[e2e] leftover sweep skipped: ${(err as Error).message}`);
  } finally {
    await api.dispose();
  }
}
