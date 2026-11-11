/**
 * B3/R3 дүрэм: урт текст (хаяг, тайлбар, нэр, тасралтгүй урт үг) хүснэгт/карт/цонхноос ХАЛЬЖ ГАРАХГҮЙ.
 * Ажиллаж буй сервер дээр (UI_BASE, анхдагч http://localhost:3000) хуудас бүрийг 1440 ба 390 өргөнөөр нээж шалгана:
 *  1) хуудас бүхэлдээ хэвтээ чиглэлд хальсан эсэх;
 *  2) текст агуулсан элемент өөрийн хайрцгаас хальсан (scrollWidth > clientWidth, overflow: visible) эсэх;
 *  3) тасралтгүй урт үг таслагдалгүй (≥ дэлгэцийн өргөн) нэг мөрөнд үлдсэн эсэх.
 * Урт өгөгдөл: scripts/seed-long-text.ts (утас 95550000 захиалга, 95550002 дуудлага, 95550001 хар жагсаалт).
 * Зориуд хийсэн хэвтээ гүйлгэгчтэй (overflow-x: auto) хүснэгтийн доторх нүд ч таслагдсан байх ёстой.
 */
import { chromium, type Page } from 'playwright';

const BASE = process.env.UI_BASE ?? 'http://localhost:3000';
const PHONE = process.env.UI_PHONE ?? '80000001';
const PW = process.env.UI_PASSWORD ?? 'Test1234';
const MARK = 'Зайгүймаашуртүг';
const DRIVER = process.env.UI_DRIVER ?? '80000099';
const SUPPLIER = process.env.UI_SUPPLIER ?? '80000150';
const MARKETER = process.env.UI_MARKETER ?? '80000144';

type Issue = { kind: string; text: string; w: number; box: number };

async function audit(page: Page): Promise<Issue[]> {
  return page.evaluate((mark) => {
    const out: { kind: string; text: string; w: number; box: number }[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push({ kind: 'page', text: 'хуудас хэвтээ хальсан', w: document.documentElement.scrollWidth, box: vw });
    const els = Array.from(document.querySelectorAll<HTMLElement>('body *'));
    for (const el of els) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
      if (!own) continue;
      if (el.closest('input,textarea,select,[data-overflow-ok]')) continue;
      const cs = getComputedStyle(el);
      const t = (el.textContent ?? '').trim().slice(0, 60);
      // 2) хайрцгаасаа хальсан (харагдахуйц)
      if (cs.overflowX === 'visible' && cs.display !== 'inline' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        out.push({ kind: 'spill', text: t, w: el.scrollWidth, box: el.clientWidth });
        continue;
      }
      // 3) урт үг таслагдаагүй
      if ((el.textContent ?? '').includes(mark)) {
        const r = el.getBoundingClientRect();
        const cell = (el.closest('td,th,li,dialog,[class*="card"],section') as HTMLElement | null) ?? el.parentElement!;
        const inScroller = (() => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; })();
        if (r.width > vw || (!inScroller && r.right > vw + 1) || (r.right > cell.getBoundingClientRect().right + 2 && cs.overflowX === 'visible'))
          out.push({ kind: 'longword', text: t, w: Math.round(r.width), box: Math.round(cell.getBoundingClientRect().width) });
      }
    }
    // 5) богино үг/тоо (утас, дугаар, дүн, огноо) дундаа тасарсан
    for (const el of els) {
      if (!el.offsetParent) continue;
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType !== 3) continue;
        for (const m of (n.textContent ?? '').matchAll(/[^\s]{4,16}/g)) {
          if (!/\d/.test(m[0]) || /[-–/:]/.test(m[0])) continue;
          const rg = document.createRange(); rg.setStart(n, m.index!); rg.setEnd(n, m.index! + m[0].length);
          const lines = new Set(Array.from(rg.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
          if (lines > 1) { out.push({ kind: 'broken', text: m[0], w: lines, box: 0 }); break; }
        }
      }
    }
    // 4) хүснэгтийн нүд хэт шахагдаж (үг бүр шинэ мөрөнд) уншигдахгүй болсон
    for (const td of Array.from(document.querySelectorAll<HTMLElement>('td'))) {
      const len = (td.textContent ?? '').trim().length; const w = td.getBoundingClientRect().width;
      if (td.offsetParent && ((len > 40 && w > 0 && w < 110) || (len > 80 && w > 0 && w < 170 && td.getBoundingClientRect().height > 120))) out.push({ kind: 'squeezed', text: (td.textContent ?? '').trim().slice(0, 60), w: Math.round(w), box: len });
    }
    return out;
  }, MARK);
}

async function main() {
  const browser = await chromium.launch();
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: PHONE, password: PW }) });
  const m = /zs=([^;]+)/.exec(login.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('login амжилтгүй');
  const url = new URL(BASE);
  const cookies = new Map<string, string>();
  const cookieOf = async (phone: string) => {
    if (!cookies.has(phone)) {
      const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: PW }) });
      const c = /zs=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
      if (!c) throw new Error(`login ${phone} амжилтгүй`);
      cookies.set(phone, c[1]!);
    }
    return cookies.get(phone)!;
  };
  const ids = await (async () => {
    const j = await (await fetch(BASE + '/api/orders?q=95550000', { headers: { cookie: `zs=${m[1]}` } })).json() as { items: { id: number }[] };
    const h = await (await fetch(BASE + '/api/handover?history=1', { headers: { cookie: `zs=${m[1]}` } })).json() as { items?: { id: number }[] };
    return { order: j.items[0]?.id, handover: h.items?.[0]?.id };
  })();
  if (!ids.order) throw new Error('Урт өгөгдөл олдсонгүй: эхлээд scripts/seed-long-text.ts ажиллуул');

  type Step = { name: string; path: string; act?: (p: Page) => Promise<void>; as?: string };
  const steps: Step[] = [
    { name: 'Захиалга жагсаалт (хайлт)', path: '/orders?q=95550000' },
    { name: 'Захиалга жагсаалт', path: '/orders' },
    { name: 'Шинэ захиалга + хэрэглэгчийн карт', path: '/orders/new', act: async (p) => {
      await p.fill('input[placeholder="99887766"]', '95550000'); await p.waitForTimeout(1500);
      const t = p.getByText(/өмнөх захиалга|Захиалгууд/i).first(); if (await t.count()) await t.click().catch(() => {}); await p.waitForTimeout(500);
    } },
    { name: 'Захиалга засах цонх', path: `/orders/${ids.order}/edit` },
    { name: 'Захиалга дэлгэрэнгүй', path: `/orders/${ids.order}` },
    { name: 'Түүх цонх', path: '/orders?q=95550000', act: async (p) => { await p.locator('button[title*="Түүх"]').first().click(); await p.waitForTimeout(1000); } },
    { name: 'Дуудлагын бүртгэл', path: '/orders/calls', act: async (p) => { await p.waitForTimeout(1000); const s = p.getByText('Бүгд', { exact: true }).first(); if (await s.count()) await s.click().catch(() => {}); await p.waitForTimeout(800); } },
    { name: 'Хар жагсаалт', path: '/orders/blacklist' },
    { name: 'Пэйж', path: '/orders/pages' },
    { name: 'Ахлах жолооч', path: '/driver-lead?assign=all&q=95550000' },
    { name: 'Ахлах жолооч (бүгд)', path: '/driver-lead?assign=all' },
    { name: 'Агуулах падаан', path: '/handover' },
    { name: 'Падааны түүх', path: '/handover/history' },
    ...(ids.handover ? [{ name: 'Падаан хэвлэх', path: `/print/handover/${ids.handover}` }] : []),
    { name: 'Бараа жагсаалт', path: '/products' },
    { name: 'Бараа каталог', path: '/products/catalog' },
    { name: 'Бараа дэлгэрэнгүй', path: '/products/1' },
    { name: 'Агуулах үлдэгдэл', path: '/warehouse/products/1' },
    { name: 'Агуулах', path: '/warehouse' },
    { name: 'Агуулах (урт нэр, жолоочид)', path: '/warehouse', act: async (p) => { await p.fill('input[placeholder*="Код, нэр"]', '00001'); await p.waitForTimeout(1200); } },
    { name: 'Хөдөлгөөн', path: '/warehouse/moves' },
    { name: 'Тайлан', path: '/reports' },
    { name: 'Хэрэглэгчид', path: '/users' },
    // Модуль 5: жолоочийн апп (жолоочоор), буцаалт, асуудал, хяналт
    { name: 'Жолооч: захиалга', path: '/driver', as: DRIVER },
    { name: 'Жолооч: хүргэсэн цонх', path: '/driver', as: DRIVER, act: async (p) => { await p.getByRole('button', { name: 'Хүргэсэн', exact: true }).first().click().catch(() => {}); await p.waitForTimeout(600); } },
    { name: 'Жолооч: падаан', path: '/driver', as: DRIVER, act: async (p) => { await p.getByRole('tab', { name: /Падаан/ }).click(); await p.waitForTimeout(1000); } },
    { name: 'Ахлах жолооч: гүйцэтгэл', path: '/driver-lead', act: async (p) => { await p.getByRole('tab', { name: 'Жолоочийн гүйцэтгэл' }).click(); await p.waitForTimeout(1200); } },
    { name: 'Ахлах жолооч: график', path: '/driver-lead', act: async (p) => { await p.getByRole('tab', { name: 'График' }).click(); await p.waitForTimeout(1200); } },
    { name: 'Жолооч: өрийн дэвтэр', path: '/driver', as: DRIVER, act: async (p) => { await p.getByRole('tab', { name: 'Өрийн дэвтэр' }).click(); await p.waitForTimeout(1000); } },
    { name: 'Жолооч: авах', path: '/driver', as: DRIVER, act: async (p) => { await p.getByRole('tab', { name: 'Авах' }).click(); await p.waitForTimeout(1000); } },
    { name: 'Жолооч: миний бараа', path: '/driver', as: DRIVER, act: async (p) => { await p.getByRole('tab', { name: 'Миний бараа' }).click(); await p.waitForTimeout(1000); } },
    { name: 'Буцаалт хүлээн авах', path: '/handover/returns', act: async (p) => { await p.locator('section button').first().click().catch(() => {}); await p.waitForTimeout(1000); } },
    { name: 'Асуудал', path: '/issues' },
    { name: 'Асуудал (шийдсэн)', path: '/issues', act: async (p) => { await p.getByText('Шийдсэн', { exact: true }).click(); await p.waitForTimeout(800); } },
    { name: 'Жолоочийн хяналт', path: '/driver-control' },
    // Модуль 6
    { name: 'Нягтлан', path: '/accounting' },
    { name: 'Нягтлан: дэлгэрэнгүй тооцоо', path: '/accounting', act: async (p) => { await p.getByRole('button', { name: /Дэлгэрэнгүй тооцоо/ }).click(); await p.getByRole('tab', { name: /Бүгд/ }).click(); await p.waitForTimeout(500); } },
    { name: 'Нягтлан: жолоочийн дэлгэрэнгүй', path: '/accounting', act: async (p) => { await p.getByRole('tab', { name: /Бүгд/ }).click(); await p.locator('[data-driver-open]:visible').first().click(); await p.waitForTimeout(1500); } },
    { name: 'Нягтлан: төлбөр тооцооны бүртгэл', path: '/accounting', act: async (p) => { await p.getByRole('button', { name: '⋯ Бусад' }).click(); await p.getByRole('button', { name: 'Төлбөр тооцооны бүртгэл' }).click(); await p.waitForTimeout(1000); await p.locator('dialog[open] button.w-full').first().click(); await p.waitForTimeout(1000); } },
    { name: 'Нягтлан: OKEY', path: '/accounting', act: async (p) => { await p.getByRole('button', { name: 'OKEY', exact: true }).click(); await p.waitForTimeout(1200); } },
    { name: 'Нягтлан: гүйцэтгэл солих', path: '/accounting', act: async (p) => { await p.getByRole('button', { name: '⋯ Бусад' }).click(); await p.getByRole('button', { name: 'Гүйцэтгэл солих' }).click(); await p.waitForTimeout(1200); } },
    { name: 'Нягтлан: цалингийн дүрэм', path: '/accounting', act: async (p) => { await p.getByRole('button', { name: '⋯ Бусад' }).click(); await p.getByRole('button', { name: 'Цалингийн дүрэм' }).click(); await p.waitForTimeout(1200); } },
    { name: 'Тохиргоо (Gmail)', path: '/settings' },
    { name: 'Алдаа удирдлага', path: '/penalties' },
    { name: 'Алдаа удирдлага: нэмэх', path: '/penalties', act: async (p) => { await p.getByRole('button', { name: '+ Торгууль нэмэх' }).click(); await p.waitForTimeout(600); await p.locator('dialog[open] .flex-wrap button').first().click(); await p.waitForTimeout(600); } },
    { name: 'Алдаа удирдлага: алдааны нэрс', path: '/penalties', act: async (p) => { await p.getByRole('button', { name: 'Алдааны нэрс' }).click(); await p.waitForTimeout(800); } },
    { name: 'Алдаа удирдлага: ажилчид', path: '/penalties', act: async (p) => { await p.getByRole('tab', { name: 'Ажилчдын мэдээлэл' }).click(); await p.waitForTimeout(500); await p.fill('input[aria-label="Ажилтан хайх"]', 'Оператор'); await p.locator('ul button').first().click(); await p.waitForTimeout(1000); } },
    { name: 'Миний торгууль (жолооч)', path: '/my-penalties', as: DRIVER },
    { name: 'Ажилтны цалин', path: '/salary' },
    { name: 'Ажилтны цалин: бодох', path: '/salary', act: async (p) => { await p.fill('input[aria-label="Ажилтан хайх"]', 'Оператор 1'); await p.waitForTimeout(400); await p.getByRole('button', { name: /1–15/ }).first().click(); await p.waitForTimeout(1500); } },
    { name: 'Ажилтны цалин: хуваарь', path: '/salary', act: async (p) => { await p.getByRole('tab', { name: 'Ажлын хуваарь' }).click(); await p.waitForTimeout(1200); } },
    { name: 'Ажилтны цалин: өр', path: '/salary', act: async (p) => { await p.getByRole('tab', { name: 'Ажилтны өр' }).click(); await p.waitForTimeout(1000); } },
    // Модуль 7в: нийлүүлэгч
    { name: 'Нийлүүлэгч', path: '/supplier' },
    { name: 'Нийлүүлэгч: өдрийн тооцоо', path: '/supplier', act: async (p) => { await p.locator('[data-shop-open]').first().click(); await p.waitForTimeout(1800); } },
    { name: 'Нийлүүлэгч: нэгтгэл', path: '/supplier', act: async (p) => { await p.locator('[data-shop-open]').first().click(); await p.waitForTimeout(1200); await p.getByRole('button', { name: 'Нэгтгэл', exact: true }).click(); await p.waitForTimeout(1500); } },
    { name: 'Нийлүүлэгч: бараа', path: '/supplier', act: async (p) => { await p.locator('[data-shop-open]').first().click(); await p.waitForTimeout(1200); await p.getByRole('button', { name: /^Бараа/ }).click(); await p.waitForTimeout(800); } },
    { name: 'Нийлүүлэгч: буцаалт', path: '/supplier', act: async (p) => { await p.locator('[data-shop-open]').first().click(); await p.waitForTimeout(1200); await p.getByRole('button', { name: /^Буцаалт/ }).click(); await p.waitForTimeout(800); } },
    { name: 'Нийлүүлэгч: нэвтрэх эрх', path: '/supplier', act: async (p) => { await p.locator('[data-shop-open]').first().click(); await p.waitForTimeout(1200); await p.getByRole('button', { name: 'Нэвтрэх эрх', exact: true }).click(); await p.waitForTimeout(600); } },
    { name: 'Нийлүүлэгч: анхдагч суутгал', path: '/supplier', act: async (p) => { await p.getByRole('button', { name: 'Анхдагч суутгал' }).click(); await p.waitForTimeout(600); } },
    { name: 'Нийлүүлэгч өөрөө', path: '/supplier', as: SUPPLIER },
    // Модуль 7г: барааны гарц
    { name: 'Барааны гарц', path: '/goods-outflow' },
    { name: 'Барааны гарц: алдагдалтай', path: '/goods-outflow?tab=red' },
    { name: 'Барааны гарц: ашиг бага', path: '/goods-outflow?tab=orange' },
    { name: 'Барааны гарц: ашгийн задаргаа', path: '/goods-outflow', act: async (p) => { await p.getByRole('button', { name: 'задаргаа' }).first().click().catch(async () => { await p.locator('td button.underline').first().click(); }); await p.waitForTimeout(1500); } },
    { name: 'Барааны гарц: ажлын цонх', path: '/goods-outflow', act: async (p) => { await p.getByRole('button', { name: 'Бусад цэс' }).click(); await p.getByRole('button', { name: 'Ажлын цонх' }).click(); await p.waitForTimeout(1500); } },
    { name: 'Барааны гарц: үнэлгээ', path: '/goods-outflow', act: async (p) => { await p.getByRole('button', { name: 'Бусад цэс' }).click(); await p.getByRole('button', { name: 'Үнэлгээ' }).click(); await p.waitForTimeout(1500); } },
    { name: 'Барааны гарц: өдрийн дэлгэрэнгүй', path: '/goods-outflow', act: async (p) => { await p.getByRole('button', { name: 'Бусад цэс' }).click(); await p.getByRole('button', { name: 'Үнэлгээ' }).click(); await p.waitForTimeout(800); await p.getByRole('button', { name: 'Өдрийн дэлгэрэнгүй' }).click(); await p.waitForTimeout(1500); } },
    { name: 'Барааны гарц: пэйж', path: '/goods-outflow', act: async (p) => { await p.getByRole('button', { name: 'Бусад цэс' }).click(); await p.getByRole('button', { name: 'Пэйж хувиарлах' }).click(); await p.waitForTimeout(1000); } },
    { name: 'Барааны гарц: статистик', path: '/goods-outflow', act: async (p) => { await p.getByRole('button', { name: 'Бусад цэс' }).click(); await p.getByRole('button', { name: 'Статистик' }).click(); await p.waitForTimeout(1000); } },
    { name: 'Барааны гарц: бараа татах', path: '/goods-outflow?tab=reorder' },
    { name: 'Барааны гарц: нөөцийн цонх', path: '/goods-outflow?sort=cover', act: async (p) => { await p.locator('[data-reorder-chip]:visible').first().click(); await p.waitForTimeout(1500); } },
    { name: 'Барааны гарц: хангаагүй пэйж', path: '/goods-outflow', act: async (p) => { await p.locator('[data-pageshort-btn]').click(); await p.waitForTimeout(1500); } },
    { name: 'Барааны гарц: тохиргоо', path: '/goods-outflow', act: async (p) => { await p.getByRole('button', { name: 'Бусад цэс' }).click(); await p.getByRole('button', { name: 'Тохиргоо' }).click(); await p.waitForTimeout(800); } },
    { name: 'Барааны гарц (маркетинг): өөрийн ажил', path: '/goods-outflow', as: MARKETER, act: async (p) => { await p.getByRole('button', { name: 'Бусад цэс' }).click(); await p.getByRole('button', { name: 'Өөрийн ажил' }).click(); await p.waitForTimeout(1200); } },
    { name: 'Банкны импорт', path: '/bank-import' },
    { name: 'Банкны импорт: дүн өөрчлөгдсөн', path: '/bank-import', act: async (p) => { await p.getByRole('button', { name: 'Дүн өөрчлөгдсөн' }).click(); await p.waitForTimeout(1000); } },
    { name: 'Жолооч: орлого', path: '/driver', as: DRIVER, act: async (p) => { await p.getByRole('tab', { name: 'Орлого' }).click(); await p.waitForTimeout(1500); } },
    { name: 'Жолооч: төлбөр тооцоо', path: '/driver', as: DRIVER, act: async (p) => { await p.getByRole('tab', { name: 'Төлбөр тооцоо' }).click(); await p.waitForTimeout(1200); } },
  ];
  let bad = 0;
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addCookies([{ name: 'zs', value: m[1]!, domain: url.hostname, path: '/' }]);
    const page = await ctx.newPage();
    for (const s of steps.filter((x) => !process.env.ONLY || x.name.includes(process.env.ONLY))) {
      try {
        await ctx.clearCookies();
        await ctx.addCookies([{ name: 'zs', value: s.as ? await cookieOf(s.as) : m[1]!, domain: url.hostname, path: '/' }]);
        await page.goto(BASE + s.path, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(600);
        if (s.act) await s.act(page);
        const issues = await audit(page);
        if (issues.length) {
          bad += issues.length;
          console.log(`✗ [${width}] ${s.name}: ${issues.length}`);
          for (const i of issues.slice(0, 6)) console.log(`    ${i.kind} ${i.w}>${i.box}  «${i.text}»`);
          await page.screenshot({ path: `${process.env.UI_SHOTS ?? '/tmp'}/overflow-${width}-${s.path.replace(/\W+/g, '_')}.png`, fullPage: true }).catch(() => {});
        } else {
          console.log(`✓ [${width}] ${s.name}`);
          if (process.env.UI_SHOTS_ALL) await page.screenshot({ path: `${process.env.UI_SHOTS}/ok-${width}-${s.path.replace(/\W+/g, '_')}.png` }).catch(() => {});
        }
      } catch (e) { bad++; console.log(`✗ [${width}] ${s.name}: ${(e as Error).message.split('\n')[0]}`); }
    }
    await ctx.close();
  }
  await browser.close();
  console.log(bad ? `\nХальсан: ${bad}` : '\nХальсан текст: 0');
  process.exit(bad ? 1 : 0);
}
main();
