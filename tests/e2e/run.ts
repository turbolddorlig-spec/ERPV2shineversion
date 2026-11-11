/**
 * HTTP түвшний бүрэн шалгалт — ажиллаж буй сервер дээр (E2E_BASE, анхдагч http://localhost:3100).
 * Тест database-д seed-test-data.ts-ийн 150 хэрэглэгч байх ёстой.
 */
import http from 'node:http';
import sharp from 'sharp';
import type { Role } from '@prisma/client';
import { PAGES, accessTo } from '../../lib/permissions';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const PW = 'Test1234';
let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, info = '') {
  if (ok) pass++; else fails.push(`${name} ${info}`);
}

async function req(path: string, opts: { cookie?: string; method?: string; body?: unknown; origin?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.origin) headers.origin = opts.origin;
  const res = await fetch(BASE + path, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location') ?? '', text, setCookie: res.headers.get('set-cookie') ?? '' };
}

async function loginAs(phone: string, password = PW) {
  const r = await req('/api/auth/login', { method: 'POST', body: { phone, password } });
  const m = /zs=([^;]+)/.exec(r.setCookie);
  return { status: r.status, cookie: m ? `zs=${m[1]}` : '', body: r.text };
}

// seed-test-data.ts-ийн дарааллаар: 80000001 = Супер админ, ...
const ROLE_PHONE: [Role[], string][] = [
  [['SUPER_ADMIN'], '80000001'], [['ADMIN'], '80000002'], [['OPERATOR_LEAD'], '80000004'], [['OPERATOR'], '80000006'],
  [['DRIVER_LEAD'], '80000026'], [['DRIVER_LEAD', 'WAREHOUSE'], '80000028'], [['DRIVER'], '80000029'],
  [['ACCOUNTING'], '80000129'], [['WAREHOUSE'], '80000132'], [['MARKETING_LEAD'], '80000139'], [['MARKETING'], '80000140'],
  [['MARKETING', 'WAREHOUSE'], '80000146'], [['PENALTY_OFFICER'], '80000147'], [['SUPPLIER'], '80000149'],
];

async function main() {
  const h = await req('/api/health');
  check('health', h.status === 200 && h.text.includes('"ok":true'), h.text);

  // 1. Нэвтрээгүй бол
  const anon = await req('/users');
  check('нэвтрээгүй → /login', anon.status === 307 && anon.location.includes('/login'), `${anon.status} ${anon.location}`);
  const anonApi = await req('/api/users');
  check('нэвтрээгүй API → 401', anonApi.status === 401);

  // 1б. IP / домэйнаар орсон хүнийг серверийн дотоод нэр (localhost) руу шилжүүлэхгүй
  for (const host of ['103.153.141.29', 'v2.example.mn']) {
    const loc = await new Promise<string>((resolve, reject) => {
      const u = new URL(BASE + '/orders');
      http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (r) => { r.resume(); resolve(r.headers.location ?? ''); }).on('error', reject);
    });
    check(`Host=${host} → өөрийн хаяг дээрээ /login`, loc === `http://${host}/login` || loc === '/login', loc);
  }

  // 2. Хуурамч cookie
  const fake = 'zs=' + 'A'.repeat(43);
  const f1 = await req('/users', { cookie: fake });
  check('хуурамч cookie хуудас → /login', f1.status === 307 && f1.location.includes('/login'), `${f1.status} ${f1.location}`);
  const f2 = await req('/api/users', { cookie: fake });
  check('хуурамч cookie API → 401', f2.status === 401);

  // 3. Role бүр × хуудас бүр
  for (const [roles, phone] of ROLE_PHONE) {
    const l = await loginAs(phone);
    check(`нэвтрэх ${roles.join('+')}`, l.status === 200 && !!l.cookie, l.body);
    if (!l.cookie) continue;
    for (const p of PAGES) {
      const r = await req(p.href, { cookie: l.cookie });
      const allowed = accessTo(roles, p.key) !== 'none';
      const ok = allowed ? r.status === 200 : r.status === 307 && r.location.includes('/forbidden');
      check(`${roles.join('+')} ${p.href} (${allowed ? 'нээлттэй' : 'хаалттай'})`, ok, `${r.status} ${r.location}`);
    }
    const api = await req('/api/users', { cookie: l.cookie });
    const canUsers = accessTo(roles, 'users') !== 'none';
    check(`${roles.join('+')} GET /api/users`, canUsers ? api.status === 200 : api.status === 403, String(api.status));
    check(`${roles.join('+')} нууц үг хариунд алга`, !/passwordHash|passwordPlain/.test(api.text));
  }

  // 4. Жолооч өөрийгөө админ болгох оролдлого
  const drv = await loginAs('80000030');
  const me = await req('/api/users', { cookie: drv.cookie, method: 'POST', body: { phone: '81111111', name: 'Хакер', roles: ['SUPER_ADMIN'] } });
  check('жолооч хэрэглэгч үүсгэж чадахгүй', me.status === 403, String(me.status));

  // 5. Өөр сайтаас ирсэн хүсэлт (CSRF)
  const adm = await loginAs('80000002');
  const csrf = await req('/api/users', { cookie: adm.cookie, method: 'POST', origin: 'https://evil.example', body: { phone: '81111112', name: 'CSRF', roles: ['OPERATOR'] } });
  check('өөр origin → 403', csrf.status === 403, String(csrf.status));

  // 6. Давхар товшилт: зэрэг 2 хүсэлт → 1 үүснэ
  const [a, b] = await Promise.all([1, 2].map(() => req('/api/users', { cookie: adm.cookie, method: 'POST', body: { phone: '81234567', name: 'Давхар', roles: ['OPERATOR'] } })));
  const codes = [a!.status, b!.status].sort();
  check('давхар товшилт → 201 + 409', codes[0] === 201 && codes[1] === 409, codes.join(','));
  const created = JSON.parse((a!.status === 201 ? a! : b!).text);
  check('түр нууц үг буцсан', typeof created.temporaryPassword === 'string' && created.temporaryPassword.length === 8);

  // 7. Түр нууц үгтэй хэрэглэгч эхлээд солих ёстой
  const t = await loginAs('81234567', created.temporaryPassword);
  check('түр нууц үгээр нэвтэрсэн', t.status === 200 && t.body.includes('/change-password'), t.body);
  const tPage = await req('/me', { cookie: t.cookie });
  check('түр нууц үгтэй → /change-password руу', tPage.status === 307 && tPage.location.includes('/change-password'), `${tPage.status} ${tPage.location}`);
  const tApi = await req('/api/users', { cookie: t.cookie });
  check('түр нууц үгтэй API → 403', tApi.status === 403 && tApi.text.includes('must_change_password'));
  const ch = await req('/api/auth/change-password', { cookie: t.cookie, method: 'POST', body: { currentPassword: created.temporaryPassword, newPassword: 'MyNewPass1' } });
  check('нууц үг солив', ch.status === 200, ch.text);
  const after = await req('/orders', { cookie: t.cookie });
  check('солисны дараа ажиллана', after.status === 200, String(after.status));

  // 8. Хаагдсан хэрэглэгчийн нэвтрэлт шууд хүчингүй
  const list = JSON.parse((await req('/api/users?q=81234567', { cookie: adm.cookie })).text);
  const id = list.items[0]?.id;
  await req(`/api/users/${id}/deactivate`, { cookie: adm.cookie, method: 'POST', body: {} });
  const gone = await req('/orders', { cookie: t.cookie });
  check('хаагдсан → шууд гарна', gone.status === 307 && gone.location.includes('/login'), `${gone.status} ${gone.location}`);

  // 9. Ахлах оператор жолоочийг удирдаж чадахгүй
  const ol = await loginAs('80000004');
  const drvList = JSON.parse((await req('/api/users?q=80000031&status=all', { cookie: adm.cookie })).text);
  const drvId = drvList.items[0]?.id;
  const deny = await req(`/api/users/${drvId}/deactivate`, { cookie: ol.cookie, method: 'POST', body: {} });
  check('ахлах оператор жолоочийг хааж чадахгүй', deny.status === 403, String(deny.status));

  // 10. 5 буруу оролдлого → түгжээ → админ тайлна
  for (let i = 0; i < 5; i++) await loginAs('80000050', 'bad-pass');
  const locked = await loginAs('80000050');
  check('5 буруу → 423 түгжигдсэн', locked.status === 423, String(locked.status));
  const lid = JSON.parse((await req('/api/users?q=80000050', { cookie: adm.cookie })).text).items[0]?.id;
  const un = await req(`/api/users/${lid}/unlock`, { cookie: adm.cookie, method: 'POST', body: {} });
  check('админ түгжээ тайлав', un.status === 200, un.text);
  check('тайлсны дараа нэвтэрнэ', (await loginAs('80000050')).status === 200);

  // ───────── Модуль 1: Бараа ─────────
  const prodPages = ['/products', '/products/new', '/products/history', '/products/catalog', '/products/1'];
  const expectProd: Record<string, (r: Role[]) => boolean> = {
    '/products': (r) => accessTo(r, 'products') !== 'none',
    '/products/1': (r) => accessTo(r, 'products') !== 'none',
    '/products/new': (r) => accessTo(r, 'products') === 'edit',
    '/products/history': (r) => accessTo(r, 'product-history') !== 'none',
    '/products/catalog': (r) => ['SUPER_ADMIN', 'ADMIN', 'MARKETING_LEAD'].some((x) => r.includes(x as Role)),
  };
  for (const [roles, phone] of ROLE_PHONE) {
    const l = await loginAs(phone);
    if (!l.cookie) continue;
    for (const path of prodPages) {
      const r = await req(path, { cookie: l.cookie });
      const allowed = expectProd[path]!(roles);
      check(`${roles.join('+')} ${path}`, allowed ? r.status === 200 : r.status === 307, `${r.status} ${r.location}`);
    }
    // Өртөг зөвхөн админд (API хариунд ч)
    const admin = roles.includes('SUPER_ADMIN') || roles.includes('ADMIN');
    for (const api of ['/api/products?page=1', '/api/products/1', '/api/products/history?productId=1']) {
      const r = await req(api, { cookie: l.cookie });
      if (r.status !== 200) continue;
      if (admin) { if (!api.includes('history')) check(`${roles.join('+')} ${api} өртөг харагдана`, /"costPrice"/.test(r.text), r.text.slice(0, 80)); }
      else check(`${roles.join('+')} ${api} өртөг нуугдана`, !/"costPrice"/.test(r.text), r.text.slice(0, 80));
    }
    const s = await req('/api/products/search?q=пүүз', { cookie: l.cookie });
    const canSearch = accessTo(roles, 'products') !== 'none' || accessTo(roles, 'orders') !== 'none' || accessTo(roles, 'driver') !== 'none'; // Модуль 5: жолооч нэмэлт бараа хайна
    check(`${roles.join('+')} бараа хайх`, canSearch ? s.status === 200 && !/cost/i.test(s.text) : s.status === 403, String(s.status));
  }
  const mk = await loginAs('80000140'); // Маркетинг
  const before = JSON.parse((await req('/api/products/2', { cookie: mk.cookie })).text).product;
  const noReason = await req('/api/products/2', { cookie: mk.cookie, method: 'PATCH', body: { changes: { price: before.price + 1000 }, version: before.version } });
  check('тайлбаргүй засвар → 400 reason_required', noReason.status === 400 && noReason.text.includes('reason_required'), noReason.text);
  const ok = await req('/api/products/2', { cookie: mk.cookie, method: 'PATCH', body: { changes: { price: before.price + 1000 }, reason: 'E2E үнэ шалгалт', version: before.version } });
  check('тайлбартай засвар → 200', ok.status === 200, ok.text.slice(0, 120));
  const stale = await req('/api/products/2', { cookie: mk.cookie, method: 'PATCH', body: { changes: { price: before.price + 2000 }, reason: 'Хуучин хувилбараар', version: before.version } });
  check('хуучин version → 409 stale', stale.status === 409 && stale.text.includes('stale'), String(stale.status));
  const codeTry = await req('/api/products/2', { cookie: mk.cookie, method: 'PATCH', body: { changes: { code: 'HACK1' }, reason: 'Код солих оролдлого', version: before.version + 1 } });
  check('маркетинг код солихгүй → 403', codeTry.status === 403, String(codeTry.status));
  // «Бүгдийг шалгасан болгох» — зөвхөн Супер админ
  for (const [phone, who, want] of [['80000140', 'маркетинг', 403], ['80000139', 'ахлах маркетинг', 403], ['80000002', 'админ', 403], ['80000001', 'супер админ', 200]] as const) {
    const u = await loginAs(phone);
    const r = await req('/api/products/history/review-all', { cookie: u.cookie, method: 'POST', body: {} });
    check(`${who} бүгдийг шалгасан болгох → ${want}`, r.status === want, `${r.status} ${r.text.slice(0, 80)}`);
  }
  const saU = await loginAs('80000001');
  const unrev = JSON.parse((await req('/api/products/history?unreviewed=1', { cookie: saU.cookie })).text);
  check('бүгдийг шалгасны дараа шалгаагүй 0', unrev.unreviewed === 0 && unrev.total === 0, JSON.stringify({ u: unrev.unreviewed, t: unrev.total }));
  // Өртөг (#32): админ тайлбаргүй засна, маркетинг засахгүй
  const admU = await loginAs('80000002');
  const p3 = JSON.parse((await req('/api/products/3', { cookie: admU.cookie })).text).product;
  const costOk = await req('/api/products/3', { cookie: admU.cookie, method: 'PATCH', body: { changes: { costPrice: (p3.costPrice ?? 0) + 100 }, version: p3.version } });
  check('админ өртгийг тайлбаргүй засна → 200', costOk.status === 200, costOk.text.slice(0, 120));
  const p3b = JSON.parse(costOk.text).product;
  const costMk = await req('/api/products/3', { cookie: mk.cookie, method: 'PATCH', body: { changes: { costPrice: 1 }, reason: 'Өртөг засах оролдлого', version: p3b.version } });
  check('маркетинг өртөг засахгүй → 403', costMk.status === 403, String(costMk.status));
  const listV = JSON.parse((await req('/api/products?page=1', { cookie: admU.cookie })).text);
  const withV = listV.items.find((x: { hasVariants: boolean }) => x.hasVariants);
  check('жагсаалтад хувилбар үнэтэйгээ ирнэ', !!withV && withV.variants.length > 0 && typeof withV.variants[0].price === 'number', JSON.stringify(withV?.variants?.[0] ?? null));
  // Зураг upload (multipart, HTTP). Давтан ажиллуулахад 8 зургийн хязгаарт хүрэхгүйн тулд ажиллуулалт бүрт өөр бараа
  const imgPid = 2 + (Math.floor(Date.now() / 1000) % 3000);
  const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#E8590C' } }).png().toBuffer();
  const corrupt = Buffer.concat([png.subarray(0, 60), Buffer.alloc(200, 7)]);
  const cf = new FormData();
  cf.set('file', new Blob([corrupt], { type: 'image/png' }), 'c.png'); cf.set('reason', 'E2E эвдэрхий файл');
  const cUp = await fetch(BASE + `/api/products/${imgPid}/images`, { method: 'POST', headers: { cookie: mk.cookie }, body: cf });
  check('эвдэрхий зураг → 400 (500 биш)', cUp.status === 400, String(cUp.status));
  const fd = new FormData();
  fd.set('file', new Blob([png], { type: 'image/png' }), 'a.png'); fd.set('reason', 'E2E зураг');
  const up = await fetch(BASE + `/api/products/${imgPid}/images`, { method: 'POST', headers: { cookie: mk.cookie }, body: fd });
  const upBody = await up.json();
  check('зураг upload → 201', up.status === 201, JSON.stringify(upBody).slice(0, 120));
  if (up.status === 201) {
    const img = await fetch(BASE + upBody.image.sm);
    check('зураг /media-аас нээгдэнэ (нэвтрээгүй ч)', img.status === 200 && img.headers.get('content-type') === 'image/webp', String(img.status));
  }
  const bad = new FormData();
  bad.set('file', new Blob([Buffer.from('not image')], { type: 'image/png' }), 'x.png'); bad.set('reason', 'E2E буруу файл');
  const badUp = await fetch(BASE + `/api/products/${imgPid}/images`, { method: 'POST', headers: { cookie: mk.cookie }, body: bad });
  check('буруу файл → 400', badUp.status === 400, String(badUp.status));
  const trav = await req('/media/../../.env');
  check('media замаар хавтаснаас гарахгүй', trav.status === 404 || trav.status === 400 || trav.status === 307, String(trav.status));

  // ───────── Модуль 2: Агуулах, үлдэгдэл ─────────
  const whPages = ['/warehouse', '/warehouse/refill', '/warehouse/transfers', '/warehouse/counts', '/warehouse/moves', '/warehouse/settings', '/warehouse/products/1', '/warehouse/receipt', '/warehouse/issue', '/warehouse/transfers/new', '/loans'];
  const operate = (r: Role[]) => ['SUPER_ADMIN', 'ADMIN', 'WAREHOUSE'].some((x) => r.includes(x as Role));
  const expectWh: Record<string, (r: Role[]) => boolean> = {
    '/warehouse/receipt': operate, '/warehouse/issue': operate, '/warehouse/transfers/new': operate,
    '/loans': (r) => accessTo(r, 'loans') !== 'none',
  };
  for (const [roles, phone] of ROLE_PHONE) {
    const l = await loginAs(phone);
    if (!l.cookie) continue;
    for (const path of whPages) {
      const r = await req(path, { cookie: l.cookie });
      const allowed = (expectWh[path] ?? ((x: Role[]) => accessTo(x, 'warehouse') !== 'none'))(roles);
      check(`${roles.join('+')} ${path}`, allowed ? r.status === 200 : r.status === 307, `${r.status} ${r.location}`);
    }
    // API: орлого оруулах эрх (зөвхөн СА, А, Агуулах)
    const rc = await req('/api/stock/receipts', { cookie: l.cookie, method: 'POST', body: { warehouseId: 1, lines: [{ variantId: 1, qty: 1 }], idemKey: `e2e-${phone}-x1-${Date.now()}` } });
    check(`${roles.join('+')} орлого API`, operate(roles) ? rc.status === 201 : rc.status === 403, `${rc.status} ${rc.text.slice(0, 80)}`);
    const sl = await req('/api/stock?page=1', { cookie: l.cookie });
    check(`${roles.join('+')} үлдэгдэл API`, accessTo(roles, 'warehouse') !== 'none' ? sl.status === 200 : sl.status === 403, String(sl.status));
  }
  const whU = await loginAs('80000132'); // Агуулах
  const balOf = async (variantId: number) => JSON.parse((await req(`/api/stock?ids=${variantId}`, { cookie: whU.cookie })).text).items[0];
  const b0 = (await balOf(2)).byWarehouse['1'] ?? 0;
  const key = `e2e-receipt-${Date.now()}`;
  const r1 = await req('/api/stock/receipts', { cookie: whU.cookie, method: 'POST', body: { warehouseId: 1, lines: [{ variantId: 2, qty: 5 }], idemKey: key } });
  const r2 = await req('/api/stock/receipts', { cookie: whU.cookie, method: 'POST', body: { warehouseId: 1, lines: [{ variantId: 2, qty: 5 }], idemKey: key } });
  check('орлого 201, давхар дарахад 200 (нэг л удаа)', r1.status === 201 && r2.status === 200, `${r1.status} ${r2.status}`);
  check('орлого үлдэгдэлд нэмэгдсэн (+5)', ((await balOf(2)).byWarehouse['1'] ?? 0) === b0 + 5);
  const big = await req('/api/stock/issues', { cookie: whU.cookie, method: 'POST', body: { warehouseId: 1, reason: 'DAMAGE', note: 'E2E хэт их зарлага', lines: [{ variantId: 2, qty: 100000 }], idemKey: `e2e-big-${Date.now()}` } });
  check('байгаагаас их зарлага → 409 insufficient_stock', big.status === 409 && big.text.includes('insufficient_stock'), big.text.slice(0, 100));
  const noNote = await req('/api/stock/issues', { cookie: whU.cookie, method: 'POST', body: { warehouseId: 1, reason: 'DAMAGE', note: '', lines: [{ variantId: 2, qty: 1 }], idemKey: `e2e-nn-${Date.now()}` } });
  check('тайлбаргүй зарлага → 400 reason_required', noNote.status === 400 && noNote.text.includes('reason_required'), noNote.text.slice(0, 100));
  // Зэрэг 5 зарлага (тус бүр 3), байгаа 10 → хоёр л амжилттай
  const vZ = 9;
  const zBefore = (await balOf(vZ)).byWarehouse['1'] ?? 0;
  if (zBefore > 10) await req('/api/stock/issues', { cookie: whU.cookie, method: 'POST', body: { warehouseId: 1, reason: 'SAMPLE', note: 'E2E бэлтгэл зарлага', lines: [{ variantId: vZ, qty: zBefore - 10 }], idemKey: `e2e-prep-${Date.now()}` } });
  else await req('/api/stock/receipts', { cookie: whU.cookie, method: 'POST', body: { warehouseId: 1, lines: [{ variantId: vZ, qty: 10 - zBefore }], idemKey: `e2e-prep-${Date.now()}` } });
  const conc = await Promise.all(Array.from({ length: 5 }, (_, i) => req('/api/stock/issues', { cookie: whU.cookie, method: 'POST', body: { warehouseId: 1, reason: 'SAMPLE', note: 'E2E зэрэг зарлага', lines: [{ variantId: vZ, qty: 3 }], idemKey: `e2e-c${i}-${Date.now()}` } })));
  check('зэрэг 5 зарлага (3 ш), байгаа 10 → 3 амжилттай, 2 татгалзсан', conc.filter((x) => x.status === 201).length === 3 && conc.filter((x) => x.status === 409).length === 2, conc.map((x) => x.status).join(','));
  check('зэрэг зарлагын дараа үлдэгдэл 1 (сөрөг биш)', ((await balOf(vZ)).byWarehouse['1'] ?? 0) === 1);
  // Шилжүүлэг 2 алхам
  const tr = await req('/api/stock/transfers', { cookie: whU.cookie, method: 'POST', body: { fromWarehouseId: 2, toWarehouseId: 1, lines: [{ variantId: 3, qty: 2 }], idemKey: `e2e-tr-${Date.now()}` } });
  const tid = JSON.parse(tr.text).transfer?.id;
  check('шилжүүлэг илгээх → 201', tr.status === 201, tr.text.slice(0, 100));
  check('илгээсэн бараа «замдаа»', (await balOf(3)).transit >= 2);
  const [rv1, rv2] = await Promise.all([1, 2].map(() => req(`/api/stock/transfers/${tid}/receive`, { cookie: whU.cookie, method: 'POST', body: { lines: [{ variantId: 3, receivedQty: 2 }] } })));
  check('зэрэг 2 хүлээн авалт → нэг л нөлөөтэй', [JSON.parse(rv1.text).duplicate, JSON.parse(rv2.text).duplicate].sort().join() === 'false,true', `${rv1.text.slice(0, 60)} | ${rv2.text.slice(0, 60)}`);
  const mkL = await req('/api/stock/transfers', { cookie: mk.cookie, method: 'POST', body: { fromWarehouseId: 2, toWarehouseId: 1, lines: [{ variantId: 3, qty: 1 }], idemKey: `e2e-mk-${Date.now()}` } });
  check('маркетинг шилжүүлэг хийхгүй → 403', mkL.status === 403, String(mkL.status));
  // Бараа зээл
  const ln = await req('/api/loans', { cookie: mk.cookie, method: 'POST', body: { lines: [{ variantId: 4, qty: 1 }], idemKey: `e2e-loan-${Date.now()}` } });
  check('маркетинг зээл хүснэ → 201', ln.status === 201, ln.text.slice(0, 100));
  const lnWh = await req('/api/loans', { cookie: whU.cookie, method: 'POST', body: { lines: [{ variantId: 4, qty: 1 }], idemKey: `e2e-loan2-${Date.now()}` } });
  check('агуулахын ажилтан өөрөө зээл хүсэхгүй → 403', lnWh.status === 403, String(lnWh.status));
  const op = await loginAs('80000006');
  const opView = JSON.parse((await req('/api/loans', { cookie: op.cookie })).text);
  check('оператор бусдын зээлийг харахгүй', opView.items.every((x: { staffName: string }) => !x.staffName.startsWith('Маркетинг')), String(opView.items.length));
  const disc = await req('/api/loans/settings', { cookie: whU.cookie, method: 'POST', body: { loanDiscount: 1 } });
  check('агуулах хямдрал засахгүй → 403', disc.status === 403, String(disc.status));
  // Журнал засах боломжгүй — тулгалт
  const rec = JSON.parse((await req('/api/stock/reconcile?fresh=1', { cookie: adm.cookie })).text);
  check('тулгалт: журнал = үлдэгдэл', rec.ok === true, JSON.stringify(rec).slice(0, 120));
  const recWh = await req('/api/stock/reconcile?fresh=1', { cookie: whU.cookie });
  check('тулгалтыг шууд ажиллуулах — зөвхөн админ', recWh.status === 403, String(recWh.status));

  // ───────── Модуль 3: Захиалга ─────────
  const ordPages = ['/orders', '/orders/new', '/orders/calls', '/orders/blacklist', '/orders/review', '/orders/pages', '/settings', '/reports'];
  const expectOrd: Record<string, (r: Role[]) => boolean> = {
    '/orders/new': (r) => accessTo(r, 'orders') === 'edit',
    '/orders/review': (r) => r.includes('SUPER_ADMIN'),
    '/orders/pages': (r) => ['SUPER_ADMIN', 'ADMIN', 'OPERATOR_LEAD'].some((x) => r.includes(x as Role)),
    '/settings': (r) => accessTo(r, 'settings') !== 'none',
    '/reports': (r) => accessTo(r, 'reports') !== 'none',
  };
  for (const [roles, phone] of ROLE_PHONE) {
    const l = await loginAs(phone);
    if (!l.cookie) continue;
    for (const path of ordPages) {
      const r = await req(path, { cookie: l.cookie });
      const allowed = (expectOrd[path] ?? ((x: Role[]) => accessTo(x, 'orders') !== 'none'))(roles);
      check(`${roles.join('+')} ${path}`, allowed ? r.status === 200 : r.status === 307, `${r.status} ${r.location}`);
    }
    const lo = await req('/api/orders?tab=today', { cookie: l.cookie });
    check(`${roles.join('+')} захиалгын API`, accessTo(roles, 'orders') !== 'none' ? lo.status === 200 : lo.status === 403, String(lo.status));
    const rp = await req('/api/reports/pages', { cookie: l.cookie });
    check(`${roles.join('+')} пэйжийн тайлан (зөвхөн СА, маркетинг)`, accessTo(roles, 'reports') !== 'none' ? rp.status === 200 : rp.status === 403, String(rp.status));
    if (rp.status === 200) check('пэйжийн тайланд мөнгөн дүн байхгүй', !/total"?:\s*\{[^}]*(amount|money|sum)/.test(rp.text) && !rp.text.includes('"amount"'));
  }
  const opA = await loginAs('80000006');
  const opB = await loginAs('80000007');
  const pg = JSON.parse((await req('/api/orders/pages', { cookie: opA.cookie })).text);
  const hits = JSON.parse((await req('/api/products/search?q=00&limit=40', { cookie: opA.cookie })).text).items as { variantId: number; price: number; available: number }[];
  const v = hits.find((h) => h.available >= 3)!;
  const ph = '9' + String(Date.now()).slice(-7);
  const body = (extra: Record<string, unknown> = {}) => ({ phone: ph, province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 13, addressDetail: 'E2E 45-р байр, 56 тоот', pageId: pg.pages[0].id, lines: [{ variantId: v.variantId, qty: 1 }], ...extra });
  const avail = async () => JSON.parse((await req(`/api/products/search?q=00&limit=40`, { cookie: opA.cookie })).text).items.find((h: { variantId: number }) => h.variantId === v.variantId).available as number;
  const a0 = await avail();
  const ik = `e2e-ord-${Date.now()}`;
  const dbl = await Promise.all([1, 2, 3].map(() => req('/api/orders', { cookie: opA.cookie, method: 'POST', body: body({ idemKey: ik }) })));
  const ids = new Set(dbl.map((x) => JSON.parse(x.text).order?.id));
  check('3 удаа зэрэг дарахад нэг л захиалга', ids.size === 1 && dbl.every((x) => x.status === 201 || x.status === 200), dbl.map((x) => x.status).join(','));
  const oid = [...ids][0];
  check('захиалга нөөц үүсгэсэн (боломжтой −1)', (await avail()) === a0 - 1);
  const dup = await req('/api/orders', { cookie: opB.cookie, method: 'POST', body: body({ idemKey: `${ik}-b` }) });
  check('өөр оператор ижил утсаар → 409 duplicate_order', dup.status === 409 && dup.text.includes('duplicate_order'), dup.text.slice(0, 100));
  const upO = await req('/api/orders', { cookie: opA.cookie, method: 'POST', body: body({ phone: '8' + ph.slice(1), idemKey: `${ik}-c`, lines: [{ variantId: v.variantId, qty: 1, unitPrice: v.price + 1000 }] }) });
  check('үнэ нэмэх → 400 price_increase', upO.status === 400 && upO.text.includes('price_increase'), upO.text.slice(0, 100));
  const lowNo = await req('/api/orders', { cookie: opA.cookie, method: 'POST', body: body({ phone: '8' + ph.slice(1), idemKey: `${ik}-d`, lines: [{ variantId: v.variantId, qty: 1, unitPrice: v.price - 1000 }] }) });
  check('шалтгаангүй хямдруулах → 400 discount_reason', lowNo.status === 400 && lowNo.text.includes('discount_reason'), lowNo.text.slice(0, 100));
  const badPh = await req('/api/orders', { cookie: opA.cookie, method: 'POST', body: body({ phone: '1234', idemKey: `${ik}-e` }) });
  check('буруу утас → 400', badPh.status === 400, String(badPh.status));
  const mkO = await req('/api/orders', { cookie: mk.cookie, method: 'POST', body: body({ phone: '7' + ph.slice(1), idemKey: `${ik}-f` }) });
  check('маркетинг захиалга үүсгэхгүй → 403', mkO.status === 403, String(mkO.status));
  const det = JSON.parse((await req(`/api/orders/${oid}`, { cookie: opB.cookie })).text).order;
  const staleO = await req(`/api/orders/${oid}`, { cookie: opB.cookie, method: 'PATCH', body: { version: det.version - 1, note: 'хуучин хувилбар' } });
  check('хуучин хувилбараар засах → 409 stale', staleO.status === 409, staleO.text.slice(0, 80));
  const cnNo = await req(`/api/orders/${oid}/cancel`, { cookie: opB.cookie, method: 'POST', body: { reason: 'CUSTOMER_CANCELLED', note: '', version: det.version } });
  check('тайлбаргүй цуцлах → 400', cnNo.status === 400, String(cnNo.status));
  const cn = await Promise.all([1, 2].map(() => req(`/api/orders/${oid}/cancel`, { cookie: opB.cookie, method: 'POST', body: { reason: 'CUSTOMER_CANCELLED', note: 'E2E үйлчлүүлэгч болилоо', version: det.version } })));
  check('зэрэг 2 цуцлалт → алдаагүй, нэг л удаа', cn.some((x) => x.status === 200) && cn.every((x) => x.status === 200 || x.status === 409), cn.map((x) => x.status).join(','));
  check('цуцалсны дараа нөөц суллагдсан', (await avail()) === a0);
  const paidOp = await req(`/api/orders/${oid}/paid`, { cookie: opA.cookie, method: 'POST', body: {} });
  check('оператор «Мөнгө орсон» дарахгүй → 403', paidOp.status === 403, String(paidOp.status));
  const st = await req('/api/settings/orders', { cookie: adm.cookie });
  check('Meta токен API хариунд гарахгүй', st.status === 200 && !/"token"\s*:/.test(st.text), st.text.slice(0, 80));
  const stOp = await req('/api/settings/orders', { cookie: opA.cookie, method: 'POST', body: { kind: 'fees', feeUB: 0 } });
  check('оператор тохиргоо өөрчлөхгүй → 403', stOp.status === 403, String(stOp.status));
  const cl = await req('/api/calls', { cookie: opA.cookie, method: 'POST', body: { phones: `${ph} 12` } });
  check('дуудлагад буруу дугаар → 400', cl.status === 400, String(cl.status));

  // ───────── Модуль 4: Падаан ─────────
  const m4Pages = ['/driver-lead', '/handover', '/handover/history', '/driver', '/issues', '/driver-control', '/handover/returns'];
  for (const [roles, phone] of ROLE_PHONE) {
    const l = await loginAs(phone);
    if (!l.cookie) continue;
    for (const path of m4Pages) {
      const r = await req(path, { cookie: l.cookie });
      const key = path === '/driver-lead' ? 'driver-lead' : path === '/driver' ? 'driver' : path === '/issues' ? 'issues' : path === '/driver-control' ? 'driver-control' : 'handover';
      check(`${roles.join('+')} ${path}`, accessTo(roles, key) !== 'none' ? r.status === 200 : r.status === 307, `${r.status} ${r.location}`);
    }
    const as = await req('/api/driver-lead/assign', { cookie: l.cookie, method: 'POST', body: { ids: [1], driverId: '00000000-0000-0000-0000-000000000000' } });
    check(`${roles.join('+')} хуваарилах API эрх`, accessTo(roles, 'driver-lead') === 'edit' ? as.status === 400 : as.status === 403, `${as.status} ${as.text.slice(0, 60)}`);
    const hv = await req('/api/handover', { cookie: l.cookie, method: 'POST', body: {} });
    check(`${roles.join('+')} падаан үүсгэх API эрх`, accessTo(roles, 'handover') === 'edit' ? hv.status === 400 : hv.status === 403, `${hv.status} ${hv.text.slice(0, 60)}`);
  }
  {
    const lead4 = await loginAs('80000026');
    const wh4 = await loginAs('80000132');
    const acc4 = await loginAs('80000129');
    const op4 = await loginAs('80000006');
    const ubToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const drivers = JSON.parse((await req(`/api/driver-lead/drivers?date=${ubToday}`, { cookie: lead4.cookie })).text).items as { id: string; name: string }[];
    // Энэ ажиллуулалтад ашиглаагүй жолооч (өнөөдрийн падаангүй)
    void drivers;
    // Ажиллуулалт бүрт шинэ жолооч (тест өгөгдлийн захиалгагүй, OKEY-гүй) — давтан ажиллуулахад зөрөхгүй
    const drvPhone = '7' + String(Date.now()).slice(-7);
    const nd = await req('/api/users', { cookie: adm.cookie, method: 'POST', body: { phone: drvPhone, name: `E2E жолооч ${drvPhone}`, roles: ['DRIVER'] } });
    const free = JSON.parse(nd.text).user as { id: string; name: string };
    const pg4 = JSON.parse((await req('/api/orders/pages', { cookie: op4.cookie })).text);
    const vs = JSON.parse((await req('/api/products/search?q=00&limit=40', { cookie: op4.cookie })).text).items as { variantId: number; available: number }[];
    const vv = vs.find((h) => h.available >= 2)!;
    await req('/api/stock/receipts', { cookie: wh4.cookie, method: 'POST', body: { warehouseId: 1, lines: [{ variantId: vv.variantId, qty: 4 }], idemKey: `e2e-m4-rc-${Date.now()}` } });
    const mk4 = (n: number) => req('/api/orders', { cookie: op4.cookie, method: 'POST', body: { phone: '6' + String(Date.now() + n).slice(-7), province: 'Улаанбаатар', district: 'Хан-Уул', khoroo: 2, addressDetail: 'E2E падаан', pageId: pg4.pages[0].id, deliveryDate: ubToday, lines: [{ variantId: vv.variantId, qty: 1 }], idemKey: `e2e-m4-${Date.now()}-${n}` } });
    const o1 = JSON.parse((await mk4(1)).text).order; const o2 = JSON.parse((await mk4(2)).text).order;
    const asg = await req('/api/driver-lead/assign', { cookie: lead4.cookie, method: 'POST', body: { ids: [o1.id, o2.id], driverId: free.id } });
    check('ахлах жолооч 2 захиалга хуваарилав', asg.status === 200 && JSON.parse(asg.text).assigned.length === 2, asg.text.slice(0, 120));
    const noOk = await req('/api/handover', { cookie: wh4.cookie, method: 'POST', body: { driverId: free.id, date: ubToday, orderIds: [o1.id, o2.id] } });
    check('OKEY-гүй жолоочид падаан үүсэхгүй → 409 not_approved', noOk.status === 409 && noOk.text.includes('not_approved'), noOk.text.slice(0, 100));
    const okA = await req('/api/handover/approvals', { cookie: acc4.cookie, method: 'POST', body: { driverId: free.id, date: ubToday, approved: true } });
    check('нягтлан OKEY өгөв', okA.status === 200, okA.text.slice(0, 80));
    const okW = await req('/api/handover/approvals', { cookie: wh4.cookie, method: 'POST', body: { driverId: free.id, date: ubToday, approved: true } });
    check('агуулах OKEY өгөхгүй → 403', okW.status === 403, String(okW.status));
    const part = await req('/api/handover', { cookie: wh4.cookie, method: 'POST', body: { driverId: free.id, date: ubToday, orderIds: [o1.id] } });
    check('бүх захиалгыг сонгоогүй → 400 not_all_selected', part.status === 400 && part.text.includes('not_all_selected'), part.text.slice(0, 100));
    const cr = await Promise.all([1, 2].map(() => req('/api/handover', { cookie: wh4.cookie, method: 'POST', body: { driverId: free.id, date: ubToday, orderIds: [o1.id, o2.id] } })));
    check('зэрэг 2 падаан үүсгэх → нэг л үүснэ', cr.filter((x) => x.status === 201).length === 1 && cr.some((x) => x.status === 409), cr.map((x) => x.status).join(','));
    const created4 = cr.find((x) => x.status === 201);
    if (!created4) { fails.push(`падаан үүсээгүй: ${cr.map((x) => x.text.slice(0, 120)).join(' | ')} · o1=${JSON.stringify(o1)?.slice(0, 80)} · asg=${asg.text.slice(0, 160)}`); }
    else {
    const hid = JSON.parse(created4.text).handover.id;
    const ed = await req(`/api/orders/${o1.id}`, { cookie: op4.cookie, method: 'PATCH', body: { version: o1.version + 1, note: 'x' } });
    check('падаанд орсон захиалгыг засахгүй → 409', ed.status === 409, ed.text.slice(0, 80));
    await req(`/api/handover/${hid}/prepare`, { cookie: wh4.cookie, method: 'POST', body: {} });
    const nc = await req(`/api/handover/${hid}/confirm`, { cookie: wh4.cookie, method: 'POST', body: {} });
    check('Check хийгээгүй бол бараа өгөхгүй → 409 not_checked', nc.status === 409 && nc.text.includes('not_checked'), nc.text.slice(0, 80));
    await req(`/api/handover/${hid}/check`, { cookie: wh4.cookie, method: 'POST', body: { variantId: vv.variantId, checked: true } });
    const balBefore = (await balOf(vv.variantId)).byWarehouse['1'] ?? 0;
    const cf = await Promise.all([1, 2].map(() => req(`/api/handover/${hid}/confirm`, { cookie: wh4.cookie, method: 'POST', body: {} })));
    check('зэрэг 2 «Барааг бүрэн өгсөн» → нэг л удаа', cf.every((x) => x.status === 200) && cf.map((x) => JSON.parse(x.text).handover.duplicate).sort().join() === 'false,true', cf.map((x) => x.text.slice(0, 40)).join(' | '));
    // #77: агуулах өгсөн ч жолооч утсаараа хүлээн авах хүртэл бараа агуулахад, захиалга «Жолоочид оноосон»
    check('агуулах өгсөн — бараа хөдлөөгүй (жолооч хүлээн авна)', ((await balOf(vv.variantId)).byWarehouse['1'] ?? 0) === balBefore);
    const st = JSON.parse((await req(`/api/orders/${o1.id}`, { cookie: op4.cookie })).text).order.status;
    check('захиалга «Жолоочид оноосон» хэвээр', st === 'ASSIGNED', st);
    const pr = await req(`/print/handover/${hid}`, { cookie: wh4.cookie });
    check('падаан хэвлэх хуудас 200', pr.status === 200 && pr.text.includes('Падаан'), String(pr.status));
    const rec4 = JSON.parse((await req('/api/stock/reconcile?fresh=1', { cookie: adm.cookie })).text);
    check('Модуль 4-ийн дараа тулгалт: журнал = үлдэгдэл', rec4.ok === true, JSON.stringify(rec4).slice(0, 120));

    // ───────── Модуль 5: Жолооч ─────────
    const ndj = JSON.parse(nd.text) as { temporaryPassword: string | null };
    const tmp = await loginAs(drvPhone, ndj.temporaryPassword ?? '');
    const newPw = `E2eDrv${Date.now() % 100000}x`;
    await req('/api/auth/change-password', { cookie: tmp.cookie, method: 'POST', body: { currentPassword: ndj.temporaryPassword, newPassword: newPw } });
    const d5 = await loginAs(drvPhone, newPw);
    check('шинэ жолооч нэвтрэв', !!d5.cookie, String(d5.status));
    const other = await loginAs('80000029');
    const before5 = JSON.parse((await req('/api/driver/orders?tab=all', { cookie: d5.cookie })).text);
    check('хүлээн авахаас өмнө карт зөвхөн хаягтай (бараа, дүн, товчгүй)', before5.items?.length === 2 && before5.items.every((x: { goodsHidden: boolean; lines: unknown[]; total: number; can: Record<string, boolean> }) => x.goodsHidden && !x.lines.length && x.total === 0 && !Object.values(x.can).some(Boolean)), JSON.stringify(before5).slice(0, 160));
    const ph = JSON.parse((await req('/api/driver/handover', { cookie: d5.cookie })).text);
    check('жолоочийн «Падаан» табд хүлээн авах падаан', ph.pending === 1 && ph.handover?.status === 'HANDED_OVER' && ph.handover.items.length === 1, JSON.stringify(ph).slice(0, 120));
    const earlyRcv = await req(`/api/driver/handover/${hid}`, { cookie: d5.cookie, method: 'POST', body: { action: 'receive' } });
    check('чагтлаагүй бол хүлээн авахгүй → 409 not_checked', earlyRcv.status === 409 && earlyRcv.text.includes('not_checked'), earlyRcv.text.slice(0, 80));
    const othRcv = await req(`/api/driver/handover/${hid}`, { cookie: other.cookie, method: 'POST', body: { action: 'check', variantId: 'all', checked: true } });
    check('өөр жолооч падааныг чагтлахгүй → 404', othRcv.status === 404, String(othRcv.status));
    await req(`/api/driver/handover/${hid}`, { cookie: d5.cookie, method: 'POST', body: { action: 'check', variantId: 'all', checked: true } });
    const rcv = await Promise.all([1, 2].map(() => req(`/api/driver/handover/${hid}`, { cookie: d5.cookie, method: 'POST', body: { action: 'receive' } })));
    check('зэрэг 2 «Барааг бүрэн хүлээн авсан» → нэг л удаа', rcv.every((x) => x.status === 200) && rcv.map((x) => JSON.parse(x.text).handover.duplicate).sort().join() === 'false,true', rcv.map((x) => x.text.slice(0, 40)).join(' | '));
    check('хүлээн авахад үндсэн агуулахаас 2 ширхэг жолоочид', ((await balOf(vv.variantId)).byWarehouse['1'] ?? 0) === balBefore - 2);
    const st5 = JSON.parse((await req(`/api/orders/${o1.id}`, { cookie: op4.cookie })).text).order.status;
    check('захиалга «Хүргэлтэд гарсан»', st5 === 'OUT_FOR_DELIVERY', st5);
    const ls5 = await req('/api/driver-lead/stats?kind=chart', { cookie: lead4.cookie });
    const ls5op = await req('/api/driver-lead/stats', { cookie: op4.cookie });
    check('ахлах жолоочийн график 14 хоног, оператор хандахгүй', ls5.status === 200 && JSON.parse(ls5.text).daily.length === 14 && ls5op.status === 403, `${ls5.status} ${ls5op.status}`);
    const lst = JSON.parse((await req('/api/driver/orders?tab=delivery', { cookie: d5.cookie })).text);
    check('жолоочийн «Хүргэлт» табд 2 захиалга', lst.items?.length === 2 && lst.items.every((x: { can: { deliver: boolean } }) => x.can.deliver), JSON.stringify(lst).slice(0, 120));
    const opDel = await req(`/api/driver/orders/${o1.id}/deliver`, { cookie: op4.cookie, method: 'POST', body: { payment: 'CASH' } });
    check('оператор жолоочийн API → 403', opDel.status === 403, String(opDel.status));
    const oth = await req(`/api/driver/orders/${o1.id}/deliver`, { cookie: other.cookie, method: 'POST', body: { payment: 'CASH' } });
    check('өөр жолоочийн захиалгыг хүргэхгүй → 404', oth.status === 404, String(oth.status));
    const dl = await Promise.all([1, 2].map(() => req(`/api/driver/orders/${o1.id}/deliver`, { cookie: d5.cookie, method: 'POST', body: { payment: 'CASH' } })));
    check('зэрэг 2 «Хүргэсэн» → нэг л удаа', dl.every((x) => x.status === 200) && dl.map((x) => JSON.parse(x.text).duplicate).sort().join() === 'false,true', dl.map((x) => x.text.slice(0, 50)).join(' | '));
    const pp = await req(`/api/driver/orders/${o2.id}/postpone`, { cookie: d5.cookie, method: 'POST', body: {} });
    const o2s = JSON.parse((await req(`/api/orders/${o2.id}`, { cookie: op4.cookie })).text).order;
    check('«Маргааш» → ижил дугаар «Шинэ», жолоочгүй', pp.status === 200 && o2s.status === 'NEW' && o2s.number === o2.number && !o2s.driverId && o2s.postponeCount === 1, `${pp.status} ${o2s.status} ${o2s.number}`);
    const rb = JSON.parse((await req('/api/returns', { cookie: wh4.cookie })).text);
    check('агуулахын буцаалтын самбарт жолооч 1ш буцаах', rb.items?.find((x: { driverId: string }) => x.driverId === free.id)?.returnable === 1, JSON.stringify(rb).slice(0, 120));
    const tooMany = await req('/api/returns', { cookie: wh4.cookie, method: 'POST', body: { driverId: free.id, lines: [{ variantId: vv.variantId, qty: 2 }], idemKey: `e2e-m5-rt-x-${Date.now()}` } });
    check('буцаахаас илүүг хүлээн авахгүй → 409', tooMany.status === 409, tooMany.text.slice(0, 80));
    const drvRet = await req('/api/returns', { cookie: d5.cookie, method: 'POST', body: { driverId: free.id, lines: [{ variantId: vv.variantId, qty: 1 }], idemKey: `e2e-m5-rt-d-${Date.now()}` } });
    check('жолооч өөрөө буцаалт хүлээн авахгүй → 403', drvRet.status === 403, String(drvRet.status));
    const rk = `e2e-m5-rt-${Date.now()}`;
    const balW = (await balOf(vv.variantId)).byWarehouse['1'] ?? 0;
    const rt = await Promise.all([1, 2].map(() => req('/api/returns', { cookie: wh4.cookie, method: 'POST', body: { driverId: free.id, lines: [{ variantId: vv.variantId, qty: 1 }], idemKey: rk } })));
    check('буцаалт (зэрэг 2 дарахад) нэг удаа, агуулахад +1', rt.every((x) => x.status === 200) && ((await balOf(vv.variantId)).byWarehouse['1'] ?? 0) === balW + 1, rt.map((x) => x.status).join(','));
    const iss = await req(`/api/issues/${o2.id}`, { cookie: op4.cookie, method: 'POST', body: { action: 'fix', note: 'Тест шийдвэр' } });
    check('оператор асуудал шийдэхгүй → 403', iss.status === 403, String(iss.status));
    const ex = await req('/api/driver/goods', { cookie: d5.cookie, method: 'POST', body: { kind: 'take', idemKey: `e2e-m5-ex-${Date.now()}`, lines: [{ variantId: vv.variantId, qty: 1 }] } });
    const exj = JSON.parse(ex.text);
    const tomorrow5 = new Date(Date.now() + 8 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
    check('нэмэлт бараа = хүсэлт (бараа хөдлөхгүй), өнөөдрийн падаан өгөгдсөн тул маргаашийн падаанд', ex.status === 200 && exj.doc?.status === 'REQUESTED' && String(exj.doc?.date).slice(0, 10) === tomorrow5, ex.text.slice(0, 120));
    const sl = await req('/api/driver/goods', { cookie: d5.cookie, method: 'POST', body: { kind: 'sale', payment: 'CASH', idemKey: `e2e-m5-sl-${Date.now()}`, lines: [{ variantId: vv.variantId, qty: 1 }] } });
    check('хүлээн аваагүй нэмэлт барааг зарахгүй → 409', sl.status === 409, sl.text.slice(0, 80));
    const cx = await req('/api/driver/goods', { cookie: d5.cookie, method: 'POST', body: { kind: 'cancel', docId: exj.doc?.id } });
    check('нэмэлт барааны хүсэлт цуцлагдав', cx.status === 200, cx.text.slice(0, 80));
    const db5 = JSON.parse((await req('/api/driver/debts', { cookie: d5.cookie })).text);
    const dbOp = await req('/api/driver/debts', { cookie: op4.cookie });
    check('жолоочийн өрийн дэвтэр өөрт л (оператор 403)', Array.isArray(db5.items) && typeof db5.summary?.amount === 'number' && dbOp.status === 403, `${JSON.stringify(db5.summary)} ${dbOp.status}`);
    const g5 = JSON.parse((await req('/api/driver/goods', { cookie: d5.cookie })).text);
    check('жолоочид бараа үлдээгүй', g5.totals?.balance === 0, JSON.stringify(g5.totals));
    const ctl = await req('/api/driver-control', { cookie: lead4.cookie });
    const ctlOp = await req('/api/driver-control', { cookie: op4.cookie });
    const me5 = JSON.parse(ctl.text).items?.find((x: { id: string }) => x.id === free.id);
    check('жолоочийн хяналт: хүргэсэн 1, маргааш 1', ctl.status === 200 && me5?.delivered === 1 && me5?.postponed === 1 && ctlOp.status === 403, JSON.stringify(me5).slice(0, 160));
    const rec5 = JSON.parse((await req('/api/stock/reconcile?fresh=1', { cookie: adm.cookie })).text);
    check('Модуль 5-ын дараа тулгалт: журнал = үлдэгдэл', rec5.ok === true, JSON.stringify(rec5).slice(0, 120));

    // ───── Модуль 6: нягтлан (падааны өдрөөр), тооцоо нийлэх, түгжээ, банк ─────
    const acc6 = await loginAs('80000129');
    const ol6 = await loginAs('80000004');
    const today6 = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const inc = JSON.parse((await req(`/api/driver/income?date=${today6}`, { cookie: d5.cookie })).text);
    check('жолоочийн «Орлого»: хүргэсэн 1, маргааш 1 (падааны өдөр)', inc.day?.delivered === 1 && inc.day?.postponed === 1 && typeof inc.day?.toReceive === 'number', JSON.stringify(inc.day ?? inc).slice(0, 160));
    const brd = JSON.parse((await req(`/api/accounting?date=${today6}`, { cookie: acc6.cookie })).text);
    const row6 = brd.items?.find((x: { driverId: string }) => x.driverId === free.id);
    check('нягтлан ба жолооч ижил тоо', row6 && row6.toReceive === inc.day.toReceive && row6.salary === inc.day.salary && row6.perf === inc.day.perf, `${row6?.toReceive} ${inc.day?.toReceive}`);
    const perms6 = await Promise.all([req('/api/accounting', { cookie: op4.cookie }), req('/api/accounting', { cookie: d5.cookie }), req('/api/driver/income', { cookie: acc6.cookie }), req('/api/accounting/salary-rules', { cookie: acc6.cookie, method: 'POST', body: {} })]);
    check('эрх: оператор/жолооч нягтлан 403, нягтлан жолоочийн орлого 403, нягтлан цалингийн дүрэм солихгүй 403', perms6.every((x) => x.status === 403), perms6.map((x) => x.status).join(','));
    const bad6 = await req('/api/driver/income', { cookie: d5.cookie, method: 'POST', body: { action: 'submit', date: today6, cash: 1, bank: 0, debt: 0 } });
    check('Бэлэн+Данс+Өр ≠ Авах дүн → 400', bad6.status === 400 || inc.day.toReceive === 1, bad6.text.slice(0, 100));
    const debtPart = inc.day.toReceive > 1000 ? 1000 : 0;
    const sub6 = await req('/api/driver/income', { cookie: d5.cookie, method: 'POST', body: { action: 'submit', date: today6, cash: inc.day.toReceive - inc.day.bank - debtPart, bank: inc.day.bank, debt: debtPart } });
    check('жолооч тооцоо илгээв', sub6.status === 200, sub6.text.slice(0, 120));
    const brd2 = JSON.parse((await req(`/api/accounting?date=${today6}`, { cookie: acc6.cookie })).text);
    const sid6 = brd2.items?.find((x: { driverId: string }) => x.driverId === free.id)?.settlement?.id;
    const ap6 = await Promise.all([1, 2].map(() => req(`/api/accounting/settlements/${sid6}/approve`, { cookie: acc6.cookie, method: 'POST', body: {} })));
    check('нягтлан баталгаажуулав (зэрэг 2 дарахад нэг удаа)', ap6.every((x) => x.status === 200), ap6.map((x) => x.status).join(','));
    const led6 = JSON.parse((await req('/api/driver/company-debts', { cookie: d5.cookie })).text);
    check('«Өр» хэсэг компанийн өрийн бүртгэлд яг 1 удаа', led6.pending?.filter((x: { kind: string }) => x.kind === 'SETTLEMENT_DEBT').length === (debtPart ? 1 : 0), JSON.stringify(led6.summary));
    const wd6 = await req('/api/driver/income', { cookie: d5.cookie, method: 'POST', body: { action: 'withdraw', date: today6 } });
    check('баталгаажсан тооцоог буцаахгүй → 409', wd6.status === 409, wd6.text.slice(0, 80));
    const bkOp = await req('/api/bank/import', { cookie: op4.cookie, method: 'POST', body: { text: 'a,b,c\n2026-01-01,x,1' } });
    const bkList = await req('/api/bank', { cookie: op4.cookie });
    const bk = await req('/api/bank/import', { cookie: ol6.cookie, method: 'POST', body: { text: `Огноо,Утга,Дүн\n${today6},99000001 e2e,5000\n${today6},зарлага,-5000` } });
    check('банк: оператор харна (импортлохгүй 403), ахлах оператор импортлоно, зарлага алгасна', bkOp.status === 403 && bkList.status === 200 && bk.status === 200 && JSON.parse(bk.text).debitsSkipped === 1, `${bkOp.status} ${bkList.status} ${bk.text.slice(0, 100)}`);
    const exp6 = await req('/api/bank/export', { cookie: ol6.cookie });
    check('банк: CSV экспорт', exp6.status === 200 && exp6.text.includes('Огноо,Утга,Дүн'), String(exp6.status));
    const rec6 = JSON.parse((await req('/api/stock/reconcile?fresh=1', { cookie: adm.cookie })).text);
    check('Модуль 6-ын дараа тулгалт: журнал = үлдэгдэл', rec6.ok === true, JSON.stringify(rec6).slice(0, 120));
    }
  }

  // ───── Модуль 7а: Алдаа удирдлага ─────
  {
    const pen = await loginAs('80000004'); // ахлах оператор
    const op8 = await loginAs('80000006');
    const users8 = JSON.parse((await req('/api/penalties', { cookie: pen.cookie })).text);
    const target = users8.staff?.find((u: { roles: string[] }) => u.roles.includes('OPERATOR'));
    const cat = await req('/api/penalties/config', { cookie: pen.cookie, method: 'POST', body: { action: 'category', type: 'OPP_ERROR', name: `E2E алдаа ${Date.now()}`, defaultAmount: 4000 } });
    check('алдааны нэр шинээр үүсгэв', cat.status === 200, cat.text.slice(0, 100));
    const cr = await req('/api/penalties', { cookie: pen.cookie, method: 'POST', body: { userId: target?.id, categoryId: JSON.parse(cat.text).id, amount: 4000 } });
    check('торгууль тавив', cr.status === 201, cr.text.slice(0, 100));
    const opTry = await req('/api/penalties', { cookie: op8.cookie, method: 'POST', body: { userId: target?.id, customName: 'x', amount: 1 } });
    const opList = await req('/api/penalties', { cookie: op8.cookie });
    check('оператор торгууль тавих / бусдынхыг харахгүй (403)', opTry.status === 403 && opList.status === 403, `${opTry.status} ${opList.status}`);
    const mine = await req('/api/my-penalties', { cookie: op8.cookie });
    check('миний торгууль 200 (зөвхөн өөрийнх)', mine.status === 200 && Array.isArray(JSON.parse(mine.text).items), String(mine.status));
    const pid = JSON.parse(cr.text).id;
    const ded = await req(`/api/penalties/${pid}/deduct`, { cookie: pen.cookie, method: 'POST', body: {} });
    check('ахлах оператор цалингаас хасахгүй (нягтлан, админ) → 403', ded.status === 403, String(ded.status));
    const cn = await req(`/api/penalties/${pid}/cancel`, { cookie: pen.cookie, method: 'POST', body: { note: 'E2E цуцлалт' } });
    check('шалтгаантай цуцлав', cn.status === 200 && JSON.parse(cn.text).penalty?.status === 'CANCELLED', cn.text.slice(0, 100));
  }

  // ───── Модуль 7б: Ажилтны цалин ─────
  {
    const acc9 = await loginAs('80000129');
    const op9 = await loginAs('80000006');
    const b9 = JSON.parse((await req('/api/salary', { cookie: acc9.cookie })).text);
    const w9 = b9.rows?.find((r: { role: string }) => r.role === 'WAREHOUSE');
    const ym9 = b9.ym;
    const cf = await req('/api/salary', { cookie: acc9.cookie, method: 'POST', body: { action: 'config', staffKey: w9?.key, salaryType: 'FIXED', baseSalary: 1500000 } });
    const sv = await req('/api/salary', { cookie: acc9.cookie, method: 'POST', body: { action: 'save', staffKey: w9?.key, ym: ym9, half: 2, baseSalary: 600000, bonusSalary: 0, additions: [{ label: 'E2E', amount: 1000 }] } });
    const rec9 = JSON.parse(sv.text);
    check('цалин хадгалав (сервер тооцно)', cf.status === 200 && sv.status === 200 && rec9.transferSalary === 601000, sv.text.slice(0, 120));
    const opB = await req('/api/salary', { cookie: op9.cookie });
    check('оператор цалингийн хуудас харахгүй (403)', opB.status === 403, String(opB.status));
    const lk = await req('/api/salary', { cookie: acc9.cookie, method: 'POST', body: { action: 'lock', id: rec9.id } });
    const sv2 = await req('/api/salary', { cookie: acc9.cookie, method: 'POST', body: { action: 'save', staffKey: w9?.key, ym: ym9, half: 2 } });
    check('цоожтой цалинг засахгүй (423)', lk.status === 200 && sv2.status === 423, `${lk.status} ${sv2.status}`);
    const ul = await req('/api/salary', { cookie: acc9.cookie, method: 'POST', body: { action: 'unlock', id: rec9.id, code: 'buruu-kod' } });
    check('буруу кодоор / кодгүй нягтлан тайлахгүй (403)', ul.status === 403, String(ul.status));
    const sa9 = await loginAs('80000001');
    const ul2 = await req('/api/salary', { cookie: sa9.cookie, method: 'POST', body: { action: 'unlock', id: rec9.id, code: 'buruu-kod' } });
    check('Супер админ тайлав (код тохируулаагүй үед) эсвэл код шаардав', ul2.status === 200 || ul2.status === 403, String(ul2.status));
  }

  // ───── «Зөвхөн ажлын байрнаас» (#86) ─────
  {
    const sa7 = await loginAs('80000001');
    const op7 = await loginAs('80000006');
    const on = await req('/api/settings/office', { cookie: sa7.cookie, method: 'POST', body: { enabled: true, roles: ['OPERATOR'], ips: [{ ip: '10.9.9.9', label: 'e2e оффис' }] } });
    try {
      check('ажлын IP тохиргоо хадгалагдав', on.status === 200, on.text.slice(0, 120));
      const api7 = await req('/api/orders', { cookie: op7.cookie });
      check('гаднаас оператор API → 403 office_only', api7.status === 403 && api7.text.includes('office_only'), `${api7.status} ${api7.text.slice(0, 80)}`);
      const pg7 = await req('/orders', { cookie: op7.cookie });
      check('гаднаас оператор хуудас → /office-only', [302, 307].includes(pg7.status) || pg7.text.includes('office-only'), String(pg7.status));
      const lg7 = await req('/api/auth/login', { method: 'POST', body: { phone: '80000007', password: PW } });
      check('гаднаас оператор нэвтрэхгүй → 403', lg7.status === 403, lg7.text.slice(0, 80));
      const wh7 = await req('/api/stock?inStock=1', { cookie: (await loginAs('80000132')).cookie });
      check('бусад роль (агуулах) хэвийн', wh7.status === 200, String(wh7.status));
      const opSet = await req('/api/settings/office', { cookie: op7.cookie, method: 'POST', body: { enabled: false } });
      check('оператор тохиргоо солихгүй', opSet.status === 403, String(opSet.status));
    } finally {
      const off = await req('/api/settings/office', { cookie: sa7.cookie, method: 'POST', body: { enabled: false, roles: ['OPERATOR'], ips: [] } });
      check('хязгаарлалт унтраав → оператор дахин орно', off.status === 200 && (await req('/api/orders', { cookie: op7.cookie })).status === 200, off.text.slice(0, 80));
    }
  }

  console.log(`\nE2E: ${pass} амжилттай, ${fails.length} алдаатай`);
  if (fails.length) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
