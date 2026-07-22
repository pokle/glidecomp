// Ad-hoc drive: verify the callout's height-above-ground readout — hidden on
// the abstract backdrop (no ground data), shown with a DEM-derived value on
// the Mapbox terrain backdrop.
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

// Follow the leader mid-race.
await page.evaluate(() => {
  document.querySelector('#legend li .name').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  window.__viewer.setTime(9000);
});
await page.waitForTimeout(1500);
const abstract = await page.evaluate(() => ({
  alt: document.getElementById('coAlt').textContent,
  aglHidden: document.getElementById('coAgl').classList.contains('hidden'),
}));
console.log('abstract backdrop:', JSON.stringify(abstract));

// Switch to the terrain backdrop (button lives in the closed drawer, so click
// it programmatically) and wait for the DEM to feed the readout.
await page.evaluate(() => document.getElementById('bdTerrain').click());
await page.waitForFunction(
  () => !document.getElementById('coAgl').classList.contains('hidden'),
  { timeout: 60_000 },
);
const terrain = await page.evaluate(() => ({
  alt: document.getElementById('coAlt').textContent,
  agl: document.getElementById('coAgl').textContent,
}));
console.log('terrain backdrop:', JSON.stringify(terrain));
await page.waitForTimeout(1500); // let tiles paint for the screenshot
await page.screenshot({ path: '.claude/skills/run-glidecomp/shots/replay-agl.png' });

if (errors.length) {
  console.error('console errors:', errors);
  process.exit(1);
}
if (!abstract.aglHidden) throw new Error('AGL row should be hidden on the abstract backdrop');
if (!/ AGL$/.test(terrain.agl)) throw new Error(`unexpected AGL text: ${terrain.agl}`);
console.log('✓ AGL readout verified');
await browser.close();
