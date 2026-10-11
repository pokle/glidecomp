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
