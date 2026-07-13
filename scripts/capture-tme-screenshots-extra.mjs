import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = '/workspace/apps/tmeNext/docs/assets/tme-eu-cache';

const PAGES = [
  { name: '02-category', url: 'https://www.tme.eu/pl/katalog/pasywne_6/kondensatory_7/' },
  { name: '04-search', url: 'https://www.tme.eu/pl/katalog/?searchText=resistor' },
  { name: '05-cart', url: 'https://www.tme.eu/pl/Customer/Cart.html' },
];

async function dismissCookies(page) {
  for (const sel of [
    'button:has-text("Zezwól na wszystkie")',
    'button:has-text("Akceptuj")',
    '#onetrust-accept-btn-handler',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(800);
        return;
      }
    } catch {}
  }
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pl-PL' });

for (const { name, url } of PAGES) {
  const page = await context.newPage();
  console.log(`Capturing ${name}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCookies(page);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`  OK`);
  } catch (e) {
    console.error(`  FAIL:`, e.message);
  }
  await page.close();
}
await browser.close();
