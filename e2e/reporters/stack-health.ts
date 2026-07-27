/**
 * Fail fast, and honestly, when the local stack dies mid-run (issue #477).
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
 * failure is real and nothing happens. If it is down, it says so in one line
 * anyone can act on and interrupts the run (SIGINT — Playwright's own graceful
 * stop) instead of burning the remaining minutes.
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

export default class StackHealthReporter implements Reporter {
  private probing = false;
  private diagnosis: string | null = null;
  private readonly frontendUrl: string;
  private readonly frontendLabel: string;

  constructor(options: Options = {}) {
    this.frontendUrl = options.frontendUrl ?? FRONTEND_URL;
    this.frontendLabel = options.frontendLabel ?? "the Vite dev server";
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status !== "failed" && result.status !== "timedOut") return;
    if (this.diagnosis || this.probing) return;
    this.probing = true;
    void this.diagnose();
  }

  private async diagnose(): Promise<void> {
    try {
      const [api, frontend] = await Promise.all([
        reachable(API_READY_URL),
        reachable(this.frontendUrl),
      ]);
      if (api && frontend) return; // Failure is real. Carry on.

      const dead = [
        !api && `the API Workers (${API_URL} — \`bun run dev:workers\`)`,
        !frontend && `${this.frontendLabel} (${this.frontendUrl})`,
      ].filter(Boolean) as string[];

      this.diagnosis =
        `The local stack died mid-run: ${dead.join(" and ")} stopped ` +
        `answering.\n` +
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

  onEnd(_result: FullResult): void {
    // Repeat it at the bottom — with a long report the banner has scrolled off.
    if (this.diagnosis) console.error(`\n${this.diagnosis}\n`);
  }
}
