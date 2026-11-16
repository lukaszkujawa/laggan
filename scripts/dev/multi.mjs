// node scripts/dev/multi.mjs outdir spec.json [query] [w] [h]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [outdir, specFile, query = '', w = '1600', h = '900'] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 1500)}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message + '\n' + (e.stack || '').slice(0, 800)));
const t0 = Date.now();
await page.goto('http://localhost:5173/' + query);
try {
  await page.waitForFunction(() => (window.app && window.app.clock) || /wrong/.test(document.getElementById('loader-status')?.textContent || ''), null, { timeout: 180000, polling: 500 });
} catch (e) { logs.push('TIMEOUT: ' + await page.textContent('#loader-status').catch(() => '?')); }
console.log('loaded', ((Date.now() - t0) / 1000).toFixed(1), 's', await page.evaluate(() => (window.app ? 'webgpu=' + window.app.isWebGPU : document.getElementById('loader-status')?.textContent)));
await page.evaluate(() => { document.getElementById('panel')?.classList.add('hidden'); });
for (const s of spec) {
  if (s.js) { try { await page.evaluate(s.js); } catch (e) { logs.push('[eval] ' + e.message); } }
  await page.waitForTimeout(s.wait ?? 1500);
  await page.screenshot({ path: `${outdir}/${s.name}.png` });
  const fps = await page.evaluate(() => document.getElementById('stats')?.textContent).catch(() => '');
  console.log(s.name, fps);
}
const seen = new Set();
console.log(logs.filter((l) => { const k = l.slice(0, 120); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25).join('\n'));
await browser.close();
