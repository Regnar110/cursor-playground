import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = '/workspace/apps/tmeNext/docs/assets/tme-eu-cache';
const VIEWPORT = { width: 1440, height: 900 };

const PAGES = [
  { name: '01-home', url: 'https://www.tme.eu/pl/' },
  { name: '02-category', url: 'https://www.tme.eu/pl/katalog/pasywne_6/' },
  { name: '03-product', url: 'https://www.tme.eu/pl/details/1n4001-dio/' },
];

async function dismissCookies(page) {
  const selectors = [
    'button:has-text("Akceptuj")',
    'button:has-text("Accept")',
    'button:has-text("Zgadzam")',
    '#onetrust-accept-btn-handler',
    '.cookie-accept',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      /* try next */
    }
  }
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: VIEWPORT,
  locale: 'pl-PL',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});

for (const { name, url } of PAGES) {
  const page = await context.newPage();
  console.log(`Capturing ${name}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await dismissCookies(page);
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${OUT}/${name}.png`,
      fullPage: false,
    });
    await page.screenshot({
      path: `${OUT}/${name}-full.png`,
      fullPage: true,
    });
    console.log(`  OK → ${name}.png`);
  } catch (err) {
    console.error(`  FAIL ${name}:`, err.message);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log('Done.');
