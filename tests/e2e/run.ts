/**
 * HTTP түвшний бүрэн шалгалт — ажиллаж буй сервер дээр (E2E_BASE, анхдагч http://localhost:3100).
 * Тест database-д seed-test-data.ts-ийн 150 хэрэглэгч байх ёстой.
 */
import http from 'node:http';
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

  console.log(`\nE2E: ${pass} амжилттай, ${fails.length} алдаатай`);
  if (fails.length) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
