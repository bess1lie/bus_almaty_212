import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:5173/bus_almaty_212/');
await page.waitForTimeout(5000);
const speed0 = await page.locator('[data-field="speed"]').textContent();

await page.getByText('Свободная езда').click({ timeout: 3000 }).catch(() => {});
await page.keyboard.down('w');
await page.waitForTimeout(3000);
const speed1 = await page.locator('[data-field="speed"]').textContent();
const gear1 = await page.locator('[data-field="gear"]').textContent();
await page.keyboard.up('w');

await page.keyboard.down('s');
await page.waitForTimeout(1500);
const speed2 = await page.locator('[data-field="speed"]').textContent();
await page.keyboard.up('s');

console.log(JSON.stringify({ speed0, afterW: speed1, gear: gear1, afterS: speed2, errors: logs }));
await browser.close();
