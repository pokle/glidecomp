// Ad-hoc drive: verify the 3D replay callout's required-glide readout.
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/replay`, { waitUntil: 'domcontentloaded' });
// tracks loaded when the loading overlay gains .hidden (it's display:none then,
// so waitForSelector-visibility can never see it — poll the class instead)
await page.waitForFunction(
  () => document.getElementById('overlay')?.classList.contains('hidden'),
  { timeout: 60_000 },
);

// Follow the top-ranked pilot via the legend, then scrub mid-race.
await page.evaluate(() => {
  document.querySelector('#legend li .name').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
const readAt = async (t) => {
  await page.evaluate((tt) => window.__viewer.setTime(tt), t);
  await page.waitForTimeout(1300); // > the 1 s digit throttle, paused = live repaint
  return page.evaluate(() => ({
    t: window.__viewer.currentTime,
    name: document.getElementById('calloutName').textContent,
    reqRowHidden: document.getElementById('coReqRow').classList.contains('hidden'),
    req: document.getElementById('coReq').textContent,
    alt: document.getElementById('coAlt').textContent,
    glide: document.getElementById('coGlide').textContent,
    status: document.getElementById('calloutStatus').textContent,
  }));
};

// t=0 (pre-launch), mid-race, and near the end (likely in goal / landed)
const samples = [];
for (const t of [0, 9000, 12000, 14000, 15500]) samples.push(await readAt(t));
console.log(JSON.stringify(samples, null, 2));

await readAt(12000); // leave the view mid-race so the shot shows a live readout
await page.screenshot({ path: '.claude/skills/run-glidecomp/shots/replay-req-glide.png' });

if (errors.length) {
  console.error('console errors:', errors);
  process.exit(1);
}
const midRace = samples.filter((s) => /\d+(\.\d+)?:1 → /.test(s.req));
if (samples.some((s) => s.reqRowHidden)) throw new Error('required-glide row hidden despite task data');
if (midRace.length === 0) throw new Error('no sample showed a computed required glide');
console.log(`✓ required-glide readout verified (${midRace.length} samples with a live value)`);
await browser.close();
