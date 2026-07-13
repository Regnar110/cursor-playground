import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = '/workspace/apps/tmeNext/docs/assets/tme-eu-cache';
const VIEWPORT = { width: 1440, height: 900 };

async function dismissCookieBanner(page) {
  for (const sel of [
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button:has-text("Zezwól na wszystkie")',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click({ force: true });
        await page.waitForTimeout(800);
        return;
      }
    } catch {}
  }
}

async function isCloudflare(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return /weryfikacji zabezpieczeń|security verification/i.test(text);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = await browser.newPage({
  viewport: VIEWPORT,
  locale: 'pl-PL',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});

try {
  console.log('1. Home');
  await page.goto('https://www.tme.eu/pl/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);
  await dismissCookieBanner(page);
  await page.screenshot({ path: `${OUT}/01-home.png` });
  await page.screenshot({ path: `${OUT}/01-home-full.png`, fullPage: true });
  console.log('   OK');

  console.log('2. Category');
  const cat =
    page.locator('a[href*="/katalog/"]').filter({ hasText: /Elementy pasywne|Pasywne/i }).first();
  await cat.click({ timeout: 15000 });
  await page.waitForTimeout(5000);
  if (await isCloudflare(page)) throw new Error('Cloudflare category');
  await dismissCookieBanner(page);
  await page.screenshot({ path: `${OUT}/02-category.png` });
  console.log('   OK');

  console.log('3. Product');
  await page.locator('a[href*="/details/"]').first().click({ timeout: 15000 });
  await page.waitForTimeout(5000);
  if (await isCloudflare(page)) throw new Error('Cloudflare product');
  await dismissCookieBanner(page);
  await page.screenshot({ path: `${OUT}/03-product.png` });
  await page.screenshot({ path: `${OUT}/03-product-full.png`, fullPage: true });
  console.log('   OK');
} catch (err) {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

console.log('Done.');
