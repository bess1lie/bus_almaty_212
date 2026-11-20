import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/bus_almaty_212/';
const out = process.argv[3] ?? '/tmp/opencode/shot.png';

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[HTTP ${r.status()}] ${r.url()}`); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// Клик "Свободная езда", если есть
try {
  await page.getByText('Свободная езда').click({ timeout: 2000 });
  console.log('clicked free-ride');
} catch {
  console.log('no free-ride button');
}
await page.waitForTimeout(3000);

await page.screenshot({ path: out });
console.log('screenshot:', out);
console.log('--- console ---');
console.log(logs.join('\n'));
await browser.close();
