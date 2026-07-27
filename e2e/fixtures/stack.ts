/**
 * Shared facts about the local stack the e2e suite drives, and about the rows
 * the suite itself creates in it.
 *
 * Both halves exist because of issue #477. The suite writes to a *persistent*
 * local D1 file (`web/.wrangler/state`), so anything a spec creates and doesn't
 * remove is still there next run — and after ~20 runs the accumulated rows made
 * the suite flake badly and silently broke SSR discovery. So:
 *
 *  - specs name what they create with a prefix from `E2E_COMP_PREFIXES`, and
 *    delete it themselves;
 *  - `global-setup.ts` sweeps up anything a crashed run left behind, using the
 *    same prefixes;
 *  - specs sign in as one of the STABLE identities below rather than minting a
 *    fresh `…-${Date.now()}@test.local` user every run, so the `user` table
 *    stops growing too. `dev-login` signs up-or-in, so a stable email is
 *    idempotent: the row is created once and reused forever after.
 */

/** Vite dev server — the origin the browser and the specs talk to. */
export const FRONTEND_URL = "http://localhost:3000";

/**
 * The Workers, direct. Everything lives behind the dev-router on one port (see
 * web/scripts/dev-workers.sh); the frontend proxies /api/* here.
 */
export const API_URL = process.env.DEV_API_ORIGIN || "http://localhost:8790";

/** Super admin — administers every comp, so it can clean up anything. */
export const SUPER_ADMIN = {
  name: "Tushar Pokle",
  email: "tushar.pokle@gmail.com",
};

/**
 * Comp names created by the e2e suite. Any comp whose name starts with one of
 * these is fair game for the pre-run sweep — so a new spec that creates a comp
 * MUST name it with one of these prefixes (and still delete it itself; the
 * sweep is a net, not a bin).
 *
 * "API Doc Comp " is the pre-#477 name and is kept purely so an already-dirty
 * developer database gets cleaned on the first run after this change.
 */
export const E2E_COMP_PREFIXES = [
  "E2E ",
  "API Doc Comp ",
] as const;

export function isE2ECreatedComp(name: string): boolean {
  return E2E_COMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Name a comp a spec is about to create. Going through here (rather than
 * writing the string inline) is what keeps the sweep and the specs from
 * drifting apart — a comp named any other way is invisible to the sweep.
 */
export function e2eCompName(label: string): string {
  return `${E2E_COMP_PREFIXES[0]}${label}`;
}
