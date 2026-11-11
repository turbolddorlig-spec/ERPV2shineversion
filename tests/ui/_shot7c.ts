import { chromium, type Page } from 'playwright';
const B = 'http://localhost:3000';
const login = async (phone: string) => { const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: 'Test1234' }) }); return /zs=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]!; };
(async () => {
  const b = await chromium.launch();
  const shot = async (phone: string, w: number, file: string, act?: (p: Page) => Promise<void>) => {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addCookies([{ name: 'zs', value: await login(phone), domain: 'localhost', path: '/' }]);
    const p = await ctx.newPage(); await p.goto(B + '/supplier'); await p.waitForTimeout(2500);
    if (act) await act(p);
    await p.screenshot({ path: `docs/screenshots/m7/${file}`, fullPage: true }); await ctx.close();
  };
  const open = async (p: Page) => { await p.locator('[data-shop-open]', { hasText: 'Урт нэртэй' }).click(); await p.waitForTimeout(2500); };
  await shot('80000001', 1440, 'supplier-overview.png');
  await shot('80000001', 1440, 'supplier-day.png', open);
  await shot('80000001', 1440, 'supplier-products.png', async (p) => { await open(p); await p.getByRole('button', { name: /^Бараа/ }).click(); await p.waitForTimeout(800); });
  await shot('80000001', 1440, 'supplier-refunds.png', async (p) => { await open(p); await p.getByRole('button', { name: /^Буцаалт/ }).click(); await p.waitForTimeout(800); });
  await shot('80000150', 390, 'supplier-self-mobile.png');
  await b.close();
})();
