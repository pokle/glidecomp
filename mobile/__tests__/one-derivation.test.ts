/**
 * There is ONE report-card derivation (mobile plan §7, "two report-card
 * implementations drift"): the website's page and the app's hook both call
 * `buildReportCard` from @glidecomp/client, and neither defines its own.
 * Read from source, like the website's one-kit test, because the page is a
 * website module the app cannot import.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const SHARED = /import\s*\{[^}]*\bbuildReportCard\b[^}]*\}\s*from\s*["']@glidecomp\/client\/report-card["']/;

describe('the report card derivation', () => {
  it('is the shared one on the website', () => {
    const page = read('web/frontend/src/react/pages/PilotScoreDetail.tsx');
    expect(page).toMatch(SHARED);
    expect(page).not.toMatch(/function\s+build(DetailData|ReportCard)\s*\(/);
  });

  it('is the shared one in the app', () => {
    const hook = read('mobile/src/lib/use-report-card.ts');
    expect(hook).toMatch(SHARED);
    expect(hook).not.toMatch(/function\s+buildReportCard\s*\(/);
  });
});

/**
 * And ONE set of submission rules (stage 5): which endpoint, which headers,
 * what a refusal says. The website's form and the app's queue both take them
 * from @glidecomp/client/submit, so the two can never send a track
 * differently.
 */
describe('the submission rules', () => {
  const SHARED_REQUEST = /import\s*\{[^}]*\bsubmissionRequest\b[^}]*\}\s*from\s*["'](\.\/submit-track|@glidecomp\/client\/submit)["']/;

  it('are the shared ones on the website', () => {
    expect(read('web/frontend/src/react/comp/submit-track.ts')).toMatch(
      /export\s*\*\s*from\s*["']@glidecomp\/client\/submit["']/,
    );
    const form = read('web/frontend/src/react/comp/SubmitTrackForm.tsx');
    expect(form).toMatch(SHARED_REQUEST);
    expect(form).not.toMatch(/open-submit|x-pilot-ident|x-comp-pilot["']\]/);
  });

  it('are the shared ones in the app', () => {
    const queue = read('mobile/src/submit/queue.ts');
    expect(queue).toMatch(SHARED_REQUEST);
    expect(queue).not.toMatch(/open-submit|x-pilot-ident|x-comp-pilot/);
  });
});
