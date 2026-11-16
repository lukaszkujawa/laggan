// node scripts/dev/perf.mjs "<query>" ...   -> avg frame ms per view, headed Chrome 1920x1080
import { chromium } from 'playwright';
const VIEWS = {
  aerial: 'const c=app.camera; c.position.set(330,22,315); app.rig.orbit.target.set(170,-8,150);',
  ground: 'const c=app.camera; app.rig.orbit.target.set(120,-11,175); c.position.set(150,-8,215); c.position.y=app.hf.sample(150,215)+2.0; app.rig.orbit.target.y=app.hf.sample(120,175)+3;',
  street: 'const c=app.camera; c.position.set(255,0,175); c.position.y=app.hf.sample(255,175)+1.7; app.rig.orbit.target.set(300,0,160); app.rig.orbit.target.y=app.hf.sample(300,160)+1;',
};
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] });
for (const q of process.argv.slice(2)) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('http://localhost:5173/?' + q);
  await page.waitForFunction(() => window.app && window.app.clock, null, { timeout: 300000, polling: 500 });
  await page.evaluate((q) => {
    app.env.paused = true; app.env.hour = 15; app.userQuality = true;
    const p = new URLSearchParams(q);
    if (p.get('q')) app.setQuality(p.get('q'));
    if (p.has('noshadow')) app.env.light.castShadow = false;
    if (p.has('noimp')) app.veg.models.forEach((m) => { if (m.impostor) m.impostor.mesh.visible = false; });
    if (p.has('noimpshadow')) app.veg.models.forEach((m) => { if (m.impostor) m.impostor.mesh.castShadow = false; });
  }, q);
  const row = [];
  for (const [name, js] of Object.entries(VIEWS)) {
    await page.evaluate(js);
    const r = await page.evaluate(() => new Promise((res) => {
      let n = 0, t0 = 0; const cpu = [];
      const orig = app.frame.bind(app);
      app.frame = () => { const s = performance.now(); orig(); cpu.push(performance.now() - s); };
      const tick = (t) => { if (n === 30) t0 = t; if (n === 150) { app.frame = orig; const c = cpu.slice(30).sort((a,b)=>a-b); res({ ms: (t - t0) / 120, cpu: c[c.length >> 1], tris: app.renderer.info.render.triangles, calls: app.renderer.info.render.drawCalls ?? app.renderer.info.render.calls }); return; } n++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }));
    row.push(`${name}: ${r.ms.toFixed(1)}ms (cpu ${r.cpu.toFixed(1)}) ${(r.tris / 1e6).toFixed(1)}M ${r.calls}c`);
  }
  console.log((q || 'full').padEnd(26), row.join(' | '));
  await page.close();
}
await browser.close();
