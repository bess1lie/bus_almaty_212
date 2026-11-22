/** Финальная проверка: рендер, тайлы, текстуры, вход, двери, камеры, ошибки. */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:5173/bus_almaty_212/';
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});

async function run(label, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  const badResponses = [];
  const tileRequests = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 160)); });
  page.on('response', r => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
    if (r.url().includes('/map/v1/tiles/')) tileRequests.push(r.url().split('/').pop());
  });
  await page.goto(BASE);
  await page.waitForTimeout(12000);
  try { await page.getByText('Свободная езда').click({ timeout: 2000 }); } catch { /* action optional */ }
  await page.waitForTimeout(1500);

  const stats = await page.evaluate(() => {
    const d = window.__busDebug;
    const mat = new Set();
    d.bus.visual?.root?.traverse(o => { if (o.isMesh) mat.add(o.material); });
    return {
      render: { calls: d.renderer.info.render.calls, triangles: d.renderer.info.render.triangles },
      tiles: d.cityWorld.loadedTileCount,
      city: d.cityWorld.getStats(),
      street: d.streetProps.getStats(),
      busMeshes: mat.size,
      toneMapping: d.renderer.toneMapping,
      exposure: d.renderer.toneMappingExposure,
      doorAmount: d.bus.visual?.doorsOpenAmount ?? null,
      camera: d.bus.getCameraMode(),
    };
  });

  // Двери и блокировка тяги
  await page.evaluate(() => document.querySelector('[data-action="doors"]')?.click());
  await page.waitForTimeout(900);
  const doors = await page.evaluate(() => ({
    open: window.__busDebug.bus.doorsOpen,
    amount: +window.__busDebug.bus.visual.doorsOpenAmount.toFixed(2),
  }));
  await page.evaluate(() => document.querySelector('[data-action="doors"]')?.click());
  await page.evaluate(() => document.querySelector('[data-action="camera"]')?.click());
  await page.waitForTimeout(600);
  const cameraAfter = await page.evaluate(() => window.__busDebug.bus.getCameraMode());

  const counts = {};
  for (const t of tileRequests) counts[t] = (counts[t] ?? 0) + 1;
  const duplicates = Object.entries(counts).filter(([, n]) => n > 1).length;
  console.log(label, JSON.stringify({
    ...stats, doors, cameraAfter,
    tileRequests: tileRequests.length, duplicateTileRequests: duplicates,
    errors: errors.slice(0, 4), badResponses: badResponses.slice(0, 4),
  }));
  await context.close();
}

await run('DESKTOP-1920', { viewport: { width: 1920, height: 1080 } });
await run('TABLET-1365', { viewport: { width: 1365, height: 768 } });
await run('MOBILE-390', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await browser.close();
