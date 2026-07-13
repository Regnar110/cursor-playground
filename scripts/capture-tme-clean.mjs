import { chromium } from 'playwright';

const OUT = '/workspace/apps/tmeNext/docs/assets/tme-eu-cache';

async function dismissCookies(page) {
  for (const sel of ['button:has-text("Zezwól na wszystkie")', 'button:has-text("Akceptuj")']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await page.waitForTimeout(1000);
        return;
      }
    } catch {}
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pl-PL' });

for (const { name, url } of [
  { name: '01-home-clean', url: 'https://www.tme.eu/pl/' },
  { name: '03-product-clean', url: 'https://www.tme.eu/pl/details/1n4001-dio/' },
]) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await dismissCookies(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('OK', name);
  await page.close();
}
await browser.close();
