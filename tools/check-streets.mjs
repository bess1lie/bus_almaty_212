import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:5173/bus_almaty_212/');
await page.waitForTimeout(5000);
const info = await page.evaluate(() => ({
  streetData: window.__streetInfo ?? null,
  canvas: !!document.querySelector('canvas'),
  fields: [...document.querySelectorAll('[data-field]')].map((e) => e.getAttribute('data-field')),
}));
console.log(JSON.stringify(info, null, 2));
console.log('--- logs (last 15) ---');
console.log(logs.slice(-15).join('\n'));
await browser.close();
