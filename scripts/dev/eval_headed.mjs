// node scripts/dev/eval.mjs file.js [query] [out.png]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [jsFile, query = '', out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ["--enable-unsafe-webgpu","--enable-gpu","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.type() === 'log') logs.push(`[${m.type()}] ${m.text().slice(0, 1200)}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
await page.goto('http://localhost:5173/' + query);
await page.waitForFunction(() => window.app && window.app.clock, null, { timeout: 180000, polling: 500 });
const res = await page.evaluate(fs.readFileSync(jsFile, 'utf8'));
if (out) await page.screenshot({ path: out });
console.log(typeof res === 'string' ? res : JSON.stringify(res, null, 1));
console.log(logs.filter(l => !/powerPreference/.test(l)).slice(0, 30).join('\n'));
await browser.close();
