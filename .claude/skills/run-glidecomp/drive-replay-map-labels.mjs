// Ad-hoc drive: verify the 3D replay's map text — turnpoint name + altitude
// labels in Atkinson Hyperlegible Next, and the gaggle count sitting outside
// its bubble. Screenshots a top-down view at a gaggle-rich moment.
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/replay`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => document.getElementById('overlay')?.classList.contains('hidden'),
  { timeout: 60_000 },
);

const fontLoaded = await page.evaluate(() => ({
  bold: document.fonts.check('700 64px "Atkinson Hyperlegible Next"'),
  regular: document.fonts.check('400 44px "Atkinson Hyperlegible Next"'),
}));
console.log('font loaded:', JSON.stringify(fontLoaded));

// Jump to the biggest gaggle's midpoint and look straight down at it.
const gaggle = await page.evaluate(() => {
  const v = window.__viewer;
  const eps = v.gaggleResult?.episodes ?? [];
  if (!eps.length) return null;
  const best = eps.reduce((a, b) => (b.peakSize > a.peakSize ? b : a));
  v.setTime((best.tStart + best.tEnd) / 2);
  v.setFollowGaggle(best.id);
  v.topView();
  return { id: best.id, peakSize: best.peakSize, t: v.currentTime };
});
console.log('gaggle:', JSON.stringify(gaggle));
await page.waitForTimeout(1800); // camera ease + a few frames

await page.screenshot({ path: '.claude/skills/run-glidecomp/shots/replay-map-labels-gaggle.png' });

// Wide view for the turnpoint name + altitude labels.
await page.evaluate(() => {
  const v = window.__viewer;
  v.setFollowGaggle(-1);
  v.resetCamera();
  v.topView();
});
await page.waitForTimeout(1500);
await page.screenshot({ path: '.claude/skills/run-glidecomp/shots/replay-map-labels-task.png' });

if (errors.length) {
  console.error('console errors:', errors);
  process.exit(1);
}
if (!fontLoaded.bold || !fontLoaded.regular) throw new Error('Atkinson Hyperlegible Next not loaded');
if (!gaggle) throw new Error('no gaggle episodes found to verify the count label');
console.log('✓ map labels drive complete');
await browser.close();
