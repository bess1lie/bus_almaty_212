import { chromium } from '/home/bess1lie/bus_almaty_212/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
const OUT = '/tmp/opencode/tonemap';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser', headless: true,
  args: ['--no-sandbox', '--use-gl=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173/bus_almaty_212/');
await page.waitForTimeout(8000);
try { await page.getByText('Свободная езда').click({ timeout: 1500 }); } catch { /* optional action */ }
await page.evaluate(() => document.querySelector('[data-action="camera"]')?.click());
await page.waitForTimeout(800);
for (const [name, mapping, exposure] of [
  ['none', 0, 1], ['aces10', 4, 1.0], ['aces12', 4, 1.2], ['agx10', 6, 1.0], ['agx12', 6, 1.2], ['agx14', 6, 1.4],
]) {
  await page.evaluate(({ mapping, exposure }) => {
    const r = window.__busDebug.renderer;
    r.toneMapping = mapping;
    r.toneMappingExposure = exposure;
  }, { mapping, exposure });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name);
}
await browser.close();
