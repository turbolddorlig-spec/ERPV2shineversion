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
    const canSearch = accessTo(roles, 'products') !== 'none' || accessTo(roles, 'orders') !== 'none';
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
  // Зураг upload (multipart, HTTP)
  const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#E8590C' } }).png().toBuffer();
  const corrupt = Buffer.concat([png.subarray(0, 60), Buffer.alloc(200, 7)]);
  const cf = new FormData();
  cf.set('file', new Blob([corrupt], { type: 'image/png' }), 'c.png'); cf.set('reason', 'E2E эвдэрхий файл');
  const cUp = await fetch(BASE + '/api/products/2/images', { method: 'POST', headers: { cookie: mk.cookie }, body: cf });
  check('эвдэрхий зураг → 400 (500 биш)', cUp.status === 400, String(cUp.status));
  const fd = new FormData();
  fd.set('file', new Blob([png], { type: 'image/png' }), 'a.png'); fd.set('reason', 'E2E зураг');
  const up = await fetch(BASE + '/api/products/2/images', { method: 'POST', headers: { cookie: mk.cookie }, body: fd });
  const upBody = await up.json();
  check('зураг upload → 201', up.status === 201, JSON.stringify(upBody).slice(0, 120));
  if (up.status === 201) {
    const img = await fetch(BASE + upBody.image.sm);
    check('зураг /media-аас нээгдэнэ (нэвтрээгүй ч)', img.status === 200 && img.headers.get('content-type') === 'image/webp', String(img.status));
  }
  const bad = new FormData();
  bad.set('file', new Blob([Buffer.from('not image')], { type: 'image/png' }), 'x.png'); bad.set('reason', 'E2E буруу файл');
  const badUp = await fetch(BASE + '/api/products/2/images', { method: 'POST', headers: { cookie: mk.cookie }, body: bad });
  check('буруу файл → 400', badUp.status === 400, String(badUp.status));
  const trav = await req('/media/../../.env');
  check('media замаар хавтаснаас гарахгүй', trav.status === 404 || trav.status === 400 || trav.status === 307, String(trav.status));

  console.log(`\nE2E: ${pass} амжилттай, ${fails.length} алдаатай`);
  if (fails.length) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
