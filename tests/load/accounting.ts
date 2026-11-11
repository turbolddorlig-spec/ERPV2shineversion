/**
 * Модуль 6 (нягтлан) ачаалал: 1,000,000+ захиалгатай үед 150 хэрэглэгч ЗЭРЭГ.
 * 40 жолооч (шинээр үүсгэсэн, тус бүр падаанаар 5 захиалга, бүгд хүргэсэн/цуцалсан/маргааш) «Орлого» харж, тооцоо илгээж, буцааж дахин илгээнэ,
 * урьдчилгаа илгээнэ; 3 нягтлан өдрийн самбар, жолоочийн дэлгэрэнгүй, өрийн бүртгэл харж, хүлээгдэж буй тооцоог зэрэг баталгаажуулна;
 * 2 ахлах оператор банкны CSV импортлоно; бусад нь жагсаалт харна.
 * Төгсгөлд: тулгалт 0, сөрөг 0, баталгаажсан тооцоо бүр Бэлэн+Данс+Өр = хүлээн авах, нэг тооцоонд нэг л өр, нягтлан = жолоочийн тоо.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db';
import { hashPassword } from '../../lib/password';
import { createOrder } from '../../lib/services/orders/orders';
import { createReceipt } from '../../lib/services/stock/docs';
import { assignOrders } from '../../lib/services/delivery/assign';
import { confirmHandover, createHandover, handoverDetail, prepareHandover, receiveHandover, setCheck, setDriverCheck, setTrusted } from '../../lib/services/delivery/handover';
import { deliverOrder, driverCancel, postponeOrder } from '../../lib/services/delivery/driver';
import { computeDriverDay } from '../../lib/services/accounting/calc';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const USERS = Number(process.env.LOAD_USERS ?? 150);
const ITER = Number(process.env.LOAD_ITER ?? 6);
const THINK = Number(process.env.THINK_MS ?? 0);
const DRIVERS = Number(process.env.LOAD_DRIVERS ?? 40);
const PER = 5;
const think = () => (THINK > 0 ? new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random()))) : Promise.resolve());
const lat: Record<string, number[]> = {};
let errors = 0; let rejected = 0;
const samples: string[] = [];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const PW = 'Load6Driver!';
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

async function hit(kind: string, path: string, cookie: string, body?: unknown) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await r.text();
    (lat[kind] ??= []).push(performance.now() - t0);
    if (r.status === 409) rejected++;
    else if (r.status >= 400 && r.status !== 403) { errors++; if (samples.length < 8) samples.push(`${kind} ${r.status} ${text.slice(0, 120)}`); }
    return { status: r.status, text };
  } catch (e) { errors++; if (samples.length < 8) samples.push(`${kind} ${(e as Error).message}`); return null; }
}
async function login(phone: string, password = 'Test1234') {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) });
  await r.text();
  const m = /zs=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  return m ? `zs=${m[1]}` : null;
}

async function setup() {
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const sa = await act('80000001'); const op = await act('80000006'); const lead = await act('80000026'); const wh = await act('80000132');
  const prim = await db.warehouse.findFirstOrThrow({ where: { isPrimary: true } });
  const vars = await db.productVariant.findMany({ where: { isActive: true, product: { status: 'ACTIVE' } }, take: 20, orderBy: { id: 'asc' }, select: { id: true } });
  await createReceipt(wh, { warehouseId: prim.id, lines: vars.map((v) => ({ variantId: v.id, qty: DRIVERS * 3 })), idemKey: `load6-${Date.now()}` });
  const page = await db.page.findFirstOrThrow({ where: { isActive: true } });
  const hash = await hashPassword(PW);
  const out: { phone: string; id: string }[] = [];
  for (let i = 0; i < DRIVERS; i++) {
    const phone = '7' + String(Date.now() + i).slice(-7);
    const u = await db.user.create({ data: { phone, name: `Ачаалал6 жолооч ${phone}`, roles: ['DRIVER'], passwordHash: hash } });
    await setTrusted(sa, { driverId: u.id, trusted: true });
    const ids: number[] = [];
    for (let k = 0; k < PER; k++) {
      const o = await createOrder(op, { phone: '5' + String(Date.now() + i * 10 + k).slice(-7), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 3, addressDetail: 'Ачааллын тест 6', pageId: page.id, deliveryDate: today, lines: [{ variantId: pick(vars).id, qty: 1 + (k % 2) }], idemKey: randomUUID() });
      ids.push(o.order.id);
    }
    await assignOrders(lead, { ids, driverId: u.id });
    const h = await createHandover(wh, { driverId: u.id, date: today, orderIds: ids });
    await prepareHandover(wh, h.id);
    for (const it of (await handoverDetail(wh, h.id)).items) await setCheck(wh, h.id, { variantId: it.variantId, checked: true });
    await confirmHandover(wh, h.id);
    const dA = { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
    await setDriverCheck(dA, h.id, { variantId: 'all', checked: true });
    await receiveHandover(dA, h.id);
    for (const [k, id] of ids.entries()) {
      if (k < 3) await deliverOrder(dA, id, { payment: (['CASH', 'BANK', 'UNPAID'] as const)[k]! });
      else if (k === 3) await driverCancel(dA, id, { note: 'Ачааллын тест цуцлалт' });
      else await postponeOrder(dA, id, {});
    }
    out.push({ phone, id: u.id });
  }
  return out;
}

interface Inc { day: { toReceive: number; bank: number; settlement: { status: string } | null } }
async function driver(phone: string) {
  const c = await login(phone, PW); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); const r = await hit('жолооч: орлого', `/api/driver/income?date=${today}`, c);
    const d = r ? (JSON.parse(r.text) as Inc).day : null;
    if (!d) continue;
    const st = d.settlement?.status ?? 'DRAFT';
    await think();
    if (st === 'DRAFT') await hit('жолооч: тооцоо илгээх', '/api/driver/income', c, { action: 'submit', date: today, cash: d.toReceive - d.bank, bank: d.bank, debt: 0 });
    else if (st === 'PENDING' && Math.random() < 0.3) await hit('жолооч: тооцоо буцаах', '/api/driver/income', c, { action: 'withdraw', date: today });
    if (k === 1) { await think(); const key = randomUUID(); await hit('жолооч: урьдчилгаа', '/api/driver/payments', c, { kind: 'ADVANCE', date: today, amount: 10000, idemKey: key }); await hit('жолооч: урьдчилгаа (давхар)', '/api/driver/payments', c, { kind: 'ADVANCE', date: today, amount: 10000, idemKey: key }); }
    if (k % 3 === 2) { await think(); await hit('жолооч: төлбөр тооцоо', '/api/driver/company-debts', c); }
  }
}
interface Board { items: { driverId: string; settlement: { id: number; status: string } | null }[] }
async function accountant(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  for (let k = 0; k < ITER * 2; k++) {
    await think(); const b = await hit('нягтлан: өдрийн самбар', `/api/accounting?date=${today}`, c);
    const items = b ? (JSON.parse(b.text) as Board).items : [];
    const pend = items.filter((i) => i.settlement?.status === 'PENDING');
    if (pend.length) { const p = pick(pend); await think(); await hit('нягтлан: баталгаажуулах', `/api/accounting/settlements/${p.settlement!.id}/approve`, c, {}); }
    if (items.length) { await think(); await hit('нягтлан: жолоочийн дэлгэрэнгүй', `/api/accounting/driver?driverId=${pick(items).driverId}&date=${today}`, c); }
    if (k % 3 === 0) { await think(); await hit('нягтлан: өрийн бүртгэл', '/api/accounting/debts', c); await hit('нягтлан: өдрийн өр', `/api/accounting/debts?daily=${today}`, c); }
  }
}
async function bank(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think();
    const rows = Array.from({ length: 20 }, () => `${today} 12:00,${'9' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0')} ачаалал,${(1 + Math.floor(Math.random() * 9)) * 5000}`);
    await hit('банк: CSV импорт', '/api/bank/import', c, { text: ['Огноо,Утга,Дүн', ...rows].join('\n') });
    await think(); await hit('банк: жагсаалт', `/api/bank?tab=${pick(['all', 'UNMATCHED', 'MATCHED'])}`, c);
    await hit('банк: статистик', '/api/bank/stats', c);
  }
}
async function viewer(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); await hit('бусад жагсаалт', pick(['/api/driver-control', '/api/orders?statuses=DELIVERED', '/api/driver-lead/orders?assign=all', '/api/bank?tab=all']), c);
  }
}

async function main() {
  console.log(`Бэлтгэл: ${DRIVERS} жолооч × ${PER} захиалга → падаан → хүргэсэн/цуцалсан/маргааш...`);
  const drivers = await setup();
  const t0 = performance.now();
  const ACC = ['80000129', '80000130', '80000131'];
  const BANK = ['80000004', '80000005'];
  const others = Array.from({ length: 150 }, (_, i) => String(80000001 + i)).filter((p) => !ACC.includes(p) && !BANK.includes(p) && (Number(p) < 80000029 || Number(p) > 80000128));
  const need = Math.max(0, USERS - drivers.length - ACC.length - BANK.length);
  const viewers = Array.from({ length: need }, (_, i) => others[i % others.length]!);
  const jobs = [...drivers.map((d) => driver(d.phone)), ...ACC.map(accountant), ...BANK.map(bank), ...viewers.map(viewer)];
  await Promise.all(jobs);
  const secs = (performance.now() - t0) / 1000;
  const total = Object.values(lat).reduce((n, a) => n + a.length, 0);
  console.log(`\nНягтлангийн ачаалал (${THINK > 0 ? `хүний хурд ~${THINK}мс` : 'завсаргүй стресс'}): ${jobs.length} зэрэг хэрэглэгч — ${total} хүсэлт, ${secs.toFixed(1)} сек`);
  console.log('Төрөл                              тоо     p50     p95     p99   (мс)');
  for (const [k, a] of Object.entries(lat)) console.log(`${k.padEnd(34)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)}`);
  console.log(`Бизнесийн татгалзал (409): ${rejected}; алдаа: ${errors}${samples.length ? '\n  ' + samples.join('\n  ') : ''}`);
  // Шалгалтууд
  const [neg] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "StockBalance" WHERE qty < 0`;
  const [mis] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT b."locationId", b."variantId", b.qty, COALESCE(m.q, 0) AS q FROM "StockBalance" b
      LEFT JOIN (SELECT loc, "variantId", sum(q) AS q FROM (SELECT "toId" AS loc, "variantId", qty AS q FROM "StockMove" WHERE "toId" IS NOT NULL
        UNION ALL SELECT "fromId", "variantId", -qty FROM "StockMove" WHERE "fromId" IS NOT NULL) z GROUP BY 1, 2) m ON m.loc = b."locationId" AND m."variantId" = b."variantId"
      WHERE b.qty <> COALESCE(m.q, 0)) x`;
  const ids = drivers.map((d) => d.id);
  const sets = await db.driverSettlement.findMany({ where: { driverId: { in: ids }, date: new Date(`${today}T00:00:00Z`) } });
  let badSum = 0; let badCalc = 0;
  for (const s of sets) {
    const d = await computeDriverDay(db, today, s.driverId);
    if (s.status !== 'DRAFT' && s.cashAmount + s.bankAmount + s.debtAmount !== d.toReceive) badSum++;
    if (s.status === 'COMPLETED' && (!d.locked || d.delivered !== 3 || d.postponed !== 1 || d.cancelled !== 1)) badCalc++;
  }
  const [dupDebt] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT "settlementId" FROM "CompanyDebt" WHERE kind = 'SETTLEMENT_DEBT' GROUP BY 1 HAVING count(*) > 1) x`;
  const [dupPay] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT "driverId" FROM "DriverPayment" WHERE "driverId" = ANY(${ids}::uuid[]) GROUP BY 1 HAVING count(*) > 1) x`;
  const completed = sets.filter((s) => s.status === 'COMPLETED').length;
  await db.$disconnect();
  console.log(`Шалгалт: тулгалтын зөрүү ${mis!.n}, сөрөг ${neg!.n}, тооцоо (Бэлэн+Данс+Өр ≠ хүлээн авах) ${badSum}, баталгаажсан тооцооны зөрүү ${badCalc}, давхар өр ${dupDebt!.n}, давхар урьдчилгаа ${dupPay!.n}; баталгаажсан ${completed}/${sets.length}`);
  if (errors > 0 || mis!.n || neg!.n || badSum || badCalc || dupDebt!.n || dupPay!.n) process.exit(1);
}
main();
export {};
