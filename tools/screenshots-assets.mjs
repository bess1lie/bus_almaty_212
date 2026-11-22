import { chromium } from '/home/bess1lie/bus_almaty_212/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';

const OUT = process.argv[2] ?? '/home/bess1lie/bus_almaty_212/docs/visual-overhaul/after/ASSET-01';
const SIZE = process.argv[3] ?? '1920x1080';
const [w, h] = SIZE.split('x').map(Number);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser', headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const logs = [];
page.on('pageerror', e => logs.push('[PAGEERROR] ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) logs.push('[error] ' + m.text().slice(0, 160)); });
await page.goto('http://localhost:5173/bus_almaty_212/');
await page.waitForTimeout(7000);
try { await page.getByText('Свободная езда').click({ timeout: 2000 }); } catch { /* optional action */ }
await page.evaluate(() => document.querySelector('[data-action="camera"]')?.click());

// Перехватываем chase-камеру
await page.evaluate(() => {
  const b = window.__busDebug.bus;
  const orig = b.syncVisual.bind(b);
  window.__camMode = 'chase';
  window.__treePos = null;
  b.syncVisual = (dt, s, cam) => {
    orig(dt, s, cam);
    if (window.__camMode === 'tree' && window.__treePos) {
      const p = window.__treePos;
      cam.position.set(p[0] + 7, p[1] + 3.2, p[2] + 7);
      cam.lookAt(p[0], p[1] + 3.5, p[2]);
    }
  };
});
async function shot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}-${SIZE}.png` });
  console.log('shot', name);
}
await shot('01-start-street');
await page.evaluate(() => window.__busDebug.bus.body.setTranslation({ x: 1000, y: 1.55, z: 500 }, true));
await page.waitForTimeout(3500);
await shot('02-street-with-assets');
const pos = await page.evaluate(() => {
  const s = window.__busDebug.scene; let m = null;
  s.traverse(o => { if (o.name === 'street-city-tree-oak.glb') m = o; });
  if (!m || m.count === 0) return null;
  const a = m.instanceMatrix.array;
  return [a[12], a[13], a[14]];
});
if (pos) {
  await page.evaluate(p => { window.__treePos = p; window.__camMode = 'tree'; }, pos);
  await shot('03-cc0-tree');
}
console.log('STATS', JSON.stringify(await page.evaluate(() => ({
  s: window.__busDebug.streetProps.getStats(),
  r: window.__busDebug.renderer.info.render,
}))));
console.log('LOGS', logs.slice(0, 5).join('\n') || 'none');
await browser.close();
