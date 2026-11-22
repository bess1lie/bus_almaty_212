import { chromium } from '/home/bess1lie/bus_almaty_212/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';

const OUT = process.argv[2] ?? '/home/bess1lie/bus_almaty_212/docs/visual-overhaul/before';
const SIZE = process.argv[3] ?? '1920x1080';
const [w, h] = SIZE.split('x').map(Number);
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const logs = [];
page.on('pageerror', e => logs.push('[PAGEERROR] ' + e.message));
page.on('console', m => { if (m.type() === 'error') logs.push('[console.error] ' + m.text().slice(0, 200)); });
page.on('response', r => { if (r.status() >= 400) logs.push(`[HTTP ${r.status()}] ${r.url().slice(-80)}`); });
await page.goto('http://localhost:5173/bus_almaty_212/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
try { await page.getByText('Свободная езда').click({ timeout: 2000 }); } catch { /* optional action */ }
await page.waitForTimeout(2500);

// Перехватываем chase-камеру без правки кода игры
await page.evaluate(() => {
  const b = window.__busDebug.bus;
  const orig = b.syncVisual.bind(b);
  window.__cam = null;
  window.__view = 'chase';
  b.syncVisual = (dt, s, c) => {
    orig(dt, s, c);
    window.__cam = c;
    if (window.__view === 'chase') return;
    const p = b.getPosition(), f = b.getForward();
    const r = { x: -f.z, y: 0, z: f.x };
    const off = {
      front: [f.x * 11, 2.0, f.z * 11],
      rear: [-f.x * 11, 2.4, -f.z * 11],
      side_right: [r.x * 10, 1.8, r.z * 10],
      side_left: [-r.x * 10, 1.8, -r.z * 10],
      front3q: [f.x * 8 + r.x * 8, 2.4, f.z * 8 + r.z * 8],
    }[window.__view] ?? [f.x * 11, 2, f.z * 11];
    c.position.set(p.x + off[0], p.y + off[1], p.z + off[2]);
    c.lookAt(p.x, p.y + 0.3, p.z);
  };
});

async function shot(name, view) {
  await page.evaluate(v => {
    window.__view = v;
    const b = window.__busDebug.bus;
    if (v === 'driver') {
      if (b.getCameraMode() !== 'driver') document.querySelector('[data-action="camera"]')?.click();
    } else if (b.getCameraMode() !== 'chase') {
      document.querySelector('[data-action="camera"]')?.click();
    }
  }, view);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}-${SIZE}.png` });
  console.log('shot', name);
}

await shot('01-front', 'front');
await shot('02-side-right', 'side_right');
await shot('03-side-left', 'side_left');
await shot('04-rear', 'rear');
await shot('05-front3q', 'front3q');
await page.evaluate(() => {
  const b = window.__busDebug.bus;
  if (!b.doorsOpen) document.querySelector('[data-action="doors"]')?.click();
});
await shot('06-doors-open', 'side_right');
await page.evaluate(() => {
  const b = window.__busDebug.bus;
  if (b.doorsOpen) document.querySelector('[data-action="doors"]')?.click();
});
await shot('07-cabin', 'driver');
await shot('08-street', 'chase');
await page.keyboard.press('n');
await page.waitForTimeout(6000);
await shot('09-night-street', 'chase');
await shot('10-night-cabin', 'driver');

const stats = await page.evaluate(() => ({
  render: window.__busDebug.renderer.info.render,
  city: window.__busDebug.cityWorld.getStats(),
}));
console.log('STATS', JSON.stringify(stats));
console.log('LOGS', logs.slice(0, 10).join('\n') || 'none');
await browser.close();
