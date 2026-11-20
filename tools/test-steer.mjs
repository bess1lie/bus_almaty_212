import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173/bus_almaty_212/');
await page.waitForTimeout(5000);
await page.getByText('Свободная езда').click({ timeout: 3000 }).catch(() => {});

const read = () => page.evaluate(() => {
  const b = window.__busDebug;
  return b ? { pos: b.pos, yaw: b.yaw, speed: b.speed } : null;
});

await page.keyboard.down('w');
await page.waitForTimeout(2500);
await page.keyboard.up('w');
const before = await read();

await page.keyboard.down('w');
await page.keyboard.down('a');
await page.waitForTimeout(1500);
await page.keyboard.up('a');
await page.keyboard.up('w');
const afterLeft = await read();

await page.keyboard.down('w');
await page.keyboard.down('d');
await page.waitForTimeout(1500);
await page.keyboard.up('d');
await page.keyboard.up('w');
const afterRight = await read();

console.log(JSON.stringify({ before, afterLeft, afterRight }, null, 2));
await browser.close();
