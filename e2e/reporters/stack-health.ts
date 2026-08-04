/**
 * Say, honestly, what happened when the local stack dies mid-run (issue #477).
 *
 * Playwright only watches its `webServer` processes while it is *waiting* for
 * them to come up; after that, an exit goes unnoticed. So when the Workers died
 * 35 s into CI run 30251153282, every test scheduled afterwards failed against a
 * dead port and the report read as twelve unrelated product failures —
 * `settings-save-ux`, `user-files-upload`, `comp-waypoints`, `comp-detail`, no
 * coherent theme, because the only thing they shared was "ran after the crash".
 * `retries: 1` then spent its whole budget re-proving the port was still dead.
 *
 * This reporter probes the stack after a failure. If the stack is up, the
 * failure is real and nothing happens.
 *
 * If it is down, there are now two cases, because `web/scripts/dev-workers.sh`
 * supervises wrangler and restarts it (wrangler exits itself over a severed
 * client connection — see that script):
 *
 *  - It comes back. The crash cost one test, which Playwright retries against
 *    the live stack. The run continues; the reporter records the interruption
 *    so a green run still shows that the workaround fired, and nobody mistakes
 *    the wobble for a normal one.
 *  - It stays down. Then the old behaviour is the right one: say so in a line
 *    anyone can act on and interrupt the run (SIGINT — Playwright's own
 *    graceful stop) rather than burn the remaining minutes on a dead port.
 *
 * The signature to recognise WITHOUT this reporter, if you are reading an old
 * report: a page snapshot showing the app signed out where the test expected an
 * admin control means dev-login failed, i.e. the stack — not the UI.
 */
import type {
  Reporter,
  TestCase,
  TestResult,
  FullResult,
} from "@playwright/test/reporter";
import { API_URL, API_READY_URL, FRONTEND_URL } from "../fixtures/stack";

/** One probe with a short timeout — a hung port must not stall the report. */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    // Any HTTP answer proves something is listening and serving.
    return res.status < 500;
  } catch {
    return false;
  }
}

interface Options {
  /** Where the pages are served. Defaults to the Vite dev server (:3000); the
   *  SSR config serves the built output through `wrangler pages dev` instead. */
  frontendUrl?: string;
  /** How to name that server when it's the one that died. */
  frontendLabel?: string;
}

/**
 * How long to give the supervisor to bring the Workers back. Matches the
 * per-test wait in e2e/fixtures/test.ts — the two are watching the same restart,
 * and a reporter that gave up sooner would interrupt a run the tests were still
 * happily waiting out.
 */
const RECOVERY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

export default class StackHealthReporter implements Reporter {
  private probing = false;
  private diagnosis: string | null = null;
  private readonly recoveries: string[] = [];
  private readonly frontendUrl: string;
  private readonly frontendLabel: string;

  constructor(options: Options = {}) {
    this.frontendUrl = options.frontendUrl ?? FRONTEND_URL;
    this.frontendLabel = options.frontendLabel ?? "the Vite dev server";
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== "failed" && result.status !== "timedOut") return;
    if (this.diagnosis || this.probing) return;
    this.probing = true;
    void this.diagnose(test.titlePath().filter(Boolean).join(" › "));
  }

  private async diagnose(failedTest: string): Promise<void> {
    try {
      const dead = await this.whatIsDead();
      if (dead.length === 0) return; // Failure is real. Carry on.

      // The Workers are supervised (web/scripts/dev-workers.sh) and the Vite
      // dev server is not, so only the first of these can be expected back —
      // but wait either way and let the probe answer rather than assume.
      const recovered = await this.waitForRecovery();
      if (recovered !== null) {
        const note =
          `The local stack died during "${failedTest}" (${dead.join(" and ")} ` +
          `stopped answering) and came back ` +
          `${Math.round(recovered / 1000)}s later.\n` +
          `That failure is collateral, not a product failure — it is retried ` +
          `against the restarted stack.\n` +
          `The cause is wrangler exiting over a severed client connection; ` +
          `see web/scripts/dev-workers.sh.`;
        this.recoveries.push(note);
        console.error(`\n${"─".repeat(72)}\n${note}\n${"─".repeat(72)}\n`);
        return;
      }

      this.diagnosis =
        `The local stack died mid-run: ${dead.join(" and ")} stopped ` +
        `answering, and did not come back within ` +
        `${RECOVERY_TIMEOUT_MS / 1000}s.\n` +
        `Every test after this point would fail against a dead port, so the ` +
        `run was stopped.\n` +
        `Only the FIRST failure above can be a real product failure — the ` +
        `rest is collateral.\n` +
        `Look for a D1_ERROR or a ProxyController stack in the [WebServer] ` +
        `output above, not at the failing test names.`;

      console.error(`\n${"─".repeat(72)}\n${this.diagnosis}\n${"─".repeat(72)}\n`);
      // Playwright's own graceful interrupt: stop scheduling, report what ran.
      process.emit("SIGINT");
    } finally {
      this.probing = false;
    }
  }

  /** Names of the servers not answering right now; empty means all healthy. */
  private async whatIsDead(): Promise<string[]> {
    const [api, frontend] = await Promise.all([
      reachable(API_READY_URL),
      reachable(this.frontendUrl),
    ]);
    return [
      !api && `the API Workers (${API_URL} — \`bun run dev:workers\`)`,
      !frontend && `${this.frontendLabel} (${this.frontendUrl})`,
    ].filter(Boolean) as string[];
  }

  /** Milliseconds waited if everything came back, or null if it never did. */
  private async waitForRecovery(): Promise<number | null> {
    const startedAt = Date.now();
    const deadline = startedAt + RECOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if ((await this.whatIsDead()).length === 0) return Date.now() - startedAt;
    }
    return null;
  }

  onEnd(_result: FullResult): void {
    // Repeat it at the bottom — with a long report the banner has scrolled off.
    if (this.diagnosis) console.error(`\n${this.diagnosis}\n`);
    // A green run that needed a restart is still worth a line: the workaround
    // is load-bearing, and it should stay visible while it is.
    for (const note of this.recoveries) console.error(`\n${note}\n`);
  }
}
