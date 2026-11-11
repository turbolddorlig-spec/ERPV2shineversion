/**
 * Модуль 5 (жолооч) ачаалал: 1,000,000+ захиалгатай үед 150 хэрэглэгч ЗЭРЭГ.
 * 40 жолооч (энэ ажиллуулалтад шинээр үүсгэсэн, тус бүр падаанаар 5 захиалга авсан) БОДИТООР хүргэж, хэсэгчлэн хүргэж,
 * «Маргааш», цуцлах, «Опп-руу явуулах», нэмэлт бараа авч зарна; агуулах зэрэг буцаалт хүлээн авна; ахлах оператор асуудал шийднэ;
 * бусад нь жагсаалт, хяналт харна. Төгсгөлд: тулгалт 0, сөрөг үлдэгдэл 0, жолоочид «хүргэлтэд» > «гарт» 0, хүргэлтэд гарсан захиалгын бараа жолоочид.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db';
import { hashPassword } from '../../lib/password';
import { createOrder } from '../../lib/services/orders/orders';
import { createReceipt } from '../../lib/services/stock/docs';
import { assignOrders } from '../../lib/services/delivery/assign';
import { confirmHandover, createHandover, handoverDetail, prepareHandover, receiveHandover, setCheck, setDriverCheck, setTrusted } from '../../lib/services/delivery/handover';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const USERS = Number(process.env.LOAD_USERS ?? 150);
const ITER = Number(process.env.LOAD_ITER ?? 8);
const THINK = Number(process.env.THINK_MS ?? 0);
const DRIVERS = Number(process.env.LOAD_DRIVERS ?? 40);
const PER = 5;
const think = () => (THINK > 0 ? new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random()))) : Promise.resolve());
const lat: Record<string, number[]> = {};
let errors = 0; let rejected = 0;
const samples: string[] = [];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const PW = 'Load5Driver!';

async function hit(kind: string, path: string, cookie: string, body?: unknown) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await r.text();
    (lat[kind] ??= []).push(performance.now() - t0);
    if (r.status === 409) rejected++;
    else if (r.status >= 400 && r.status !== 403) { errors++; if (samples.length < 8) samples.push(`${kind} ${r.status} ${text.slice(0, 100)}`); }
    return { status: r.status, text };
  } catch (e) { errors++; if (samples.length < 8) samples.push(`${kind} ${(e as Error).message}`); return null; }
}
async function login(phone: string, password = 'Test1234') {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) });
  await r.text();
  const m = /zs=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  return m ? `zs=${m[1]}` : null;
}

/** Бэлтгэл: шинэ жолооч бүрт 5 захиалга → хуваарилж → падаан өгсөн (бараа жолоочид) */
async function setup() {
  const act = async (phone: string) => { const u = await db.user.findFirstOrThrow({ where: { phone } }); return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' }; };
  const sa = await act('80000001'); const op = await act('80000006'); const lead = await act('80000026'); const wh = await act('80000132');
  const prim = await db.warehouse.findFirstOrThrow({ where: { isPrimary: true } });
  const vars = await db.productVariant.findMany({ where: { isActive: true, product: { status: 'ACTIVE' } }, take: 20, orderBy: { id: 'asc' }, select: { id: true } });
  await createReceipt(wh, { warehouseId: prim.id, lines: vars.map((v) => ({ variantId: v.id, qty: DRIVERS * 3 })), idemKey: `load5-${Date.now()}` });
  const page = await db.page.findFirstOrThrow({ where: { isActive: true } });
  const hash = await hashPassword(PW);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const phones: string[] = [];
  for (let i = 0; i < DRIVERS; i++) {
    const phone = '7' + String(Date.now() + i).slice(-7);
    const u = await db.user.create({ data: { phone, name: `Ачаалал жолооч ${phone}`, roles: ['DRIVER'], passwordHash: hash } });
    await setTrusted(sa, { driverId: u.id, trusted: true });
    const ids: number[] = [];
    for (let k = 0; k < PER; k++) {
      const lines = [{ variantId: pick(vars).id, qty: 1 + (k % 2) }];
      const o = await createOrder(op, { phone: '5' + String(Date.now() + i * 10 + k).slice(-7), province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 3, addressDetail: 'Ачааллын тест', pageId: page.id, deliveryDate: today, lines, idemKey: randomUUID() });
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
    phones.push(phone);
  }
  return phones;
}

interface DOrd { id: number; version: number; lines: { id: number; qty: number }[]; can: { deliver: boolean; postpone: boolean; cancel: boolean; issue: boolean } }
async function driver(phone: string) {
  const c = await login(phone, PW); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); const l = await hit('жолооч: захиалга', `/api/driver/orders?tab=${pick(['all', 'delivery', 'delivery'])}`, c);
    const items = l ? ((JSON.parse(l.text).items ?? []) as DOrd[]).filter((o) => o.can.deliver) : [];
    const o = items.length ? pick(items) : null;
    if (o) {
      const r = Math.random();
      await think();
      if (r < 0.45) await hit('жолооч: хүргэсэн', `/api/driver/orders/${o.id}/deliver`, c, { payment: pick(['CASH', 'BANK', 'UNPAID']), version: o.version });
      else if (r < 0.6) await hit('жолооч: хэсэгчилсэн', `/api/driver/orders/${o.id}/deliver`, c, { payment: 'CASH', version: o.version, taken: Object.fromEntries(o.lines.map((x, i) => [x.id, i === 0 ? Math.max(1, x.qty - 1) : 0])) });
      else if (r < 0.75) await hit('жолооч: маргааш', `/api/driver/orders/${o.id}/postpone`, c, { version: o.version });
      else if (r < 0.9) await hit('жолооч: цуцлах', `/api/driver/orders/${o.id}/cancel`, c, { note: 'Ачааллын тест цуцлалт', version: o.version });
      else await hit('жолооч: асуудал', `/api/driver/orders/${o.id}/issue`, c, { type: 'UNCLEAR_ADDRESS' });
    }
    await think(); await hit('жолооч: миний бараа', '/api/driver/goods', c);
    if (k % 3 === 0) { await think(); await hit('жолооч: авах жагсаалт', '/api/driver/pickup', c); }
  }
}
async function warehouse(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); const b = await hit('агуулах: буцаалтын самбар', '/api/returns', c);
    const rows = b ? ((JSON.parse(b.text).items ?? []) as { driverId: string; returnable: number }[]).filter((x) => x.returnable > 0) : [];
    if (!rows.length) continue;
    const d = pick(rows);
    await think(); const det = await hit('агуулах: жолоочийн буцаах', `/api/returns?driverId=${d.driverId}`, c);
    const its = det ? ((JSON.parse(det.text).items ?? []) as { variantId: number; returnable: number }[]).filter((x) => x.returnable > 0) : [];
    if (its.length) { await think(); await hit('агуулах: хүлээн авсан', '/api/returns', c, { driverId: d.driverId, idemKey: randomUUID(), lines: its.map((x) => ({ variantId: x.variantId, qty: x.returnable })) }); }
  }
}
async function opLead(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); const l = await hit('ахлах оператор: асуудал', '/api/issues', c);
    const items = l ? (JSON.parse(l.text).items ?? []) as { id: number }[] : [];
    if (items.length) { await think(); await hit('ахлах оператор: шийдсэн', `/api/issues/${pick(items).id}`, c, Math.random() < 0.5 ? { action: 'fix', note: 'Утсаар тодрууллаа' } : { action: 'cancel', note: 'Хаяг олдохгүй', fault: 'OPERATOR' }); }
  }
}
async function viewer(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); await hit('хяналт / жагсаалт', pick(['/api/driver-control', '/api/orders?statuses=OUT_FOR_DELIVERY', '/api/driver-lead/orders?assign=all', '/api/stock?inStock=1']), c);
  }
}

async function main() {
  console.log(`Бэлтгэл: ${DRIVERS} жолооч × ${PER} захиалга → падаан өгсөн...`);
  const drivers = await setup();
  const t0 = performance.now();
  const WH = ['80000132', '80000133', '80000134'];
  const OPL = ['80000004', '80000005'];
  const others = Array.from({ length: 150 }, (_, i) => String(80000001 + i)).filter((p) => !WH.includes(p) && !OPL.includes(p) && (Number(p) < 80000029 || Number(p) > 80000128))
;
  // 150 хүртэл: үлдсэн хэрэглэгчид (өөр төхөөрөмжөөс нэвтэрсэн мэт) давтан
  const need = Math.max(0, USERS - drivers.length - WH.length - OPL.length);
  const viewers = Array.from({ length: need }, (_, i) => others[i % others.length]!);
  const jobs = [...drivers.map(driver), ...WH.map(warehouse), ...OPL.map(opLead), ...viewers.map(viewer)];
  await Promise.all(jobs);
  const secs = (performance.now() - t0) / 1000;
  const total = Object.values(lat).reduce((n, a) => n + a.length, 0);
  console.log(`\nЖолоочийн ачаалал (${THINK > 0 ? `хүний хурд ~${THINK}мс` : 'завсаргүй стресс'}): ${jobs.length} зэрэг хэрэглэгч — ${total} хүсэлт, ${secs.toFixed(1)} сек`);
  console.log('Төрөл                          тоо     p50     p95     p99   (мс)');
  for (const [k, a] of Object.entries(lat)) console.log(`${k.padEnd(30)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)}`);
  console.log(`Бизнесийн татгалзал (409): ${rejected}; алдаа: ${errors}${samples.length ? '\n  ' + samples.join('\n  ') : ''}`);
  const [neg] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "StockBalance" WHERE qty < 0`;
  const [mis] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT b."locationId", b."variantId", b.qty, COALESCE(m.q, 0) AS q FROM "StockBalance" b
      LEFT JOIN (SELECT loc, "variantId", sum(q) AS q FROM (SELECT "toId" AS loc, "variantId", qty AS q FROM "StockMove" WHERE "toId" IS NOT NULL
        UNION ALL SELECT "fromId", "variantId", -qty FROM "StockMove" WHERE "fromId" IS NOT NULL) z GROUP BY 1, 2) m ON m.loc = b."locationId" AND m."variantId" = b."variantId"
      WHERE b.qty <> COALESCE(m.q, 0)) x`;
  // Хүргэлтэд гарсан захиалгын бараа жолоочийн гарт заавал байх ёстой (held ≤ balance)
  const [short] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT o."driverId", l."variantId", sum(l.qty) AS held FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id WHERE o.status = 'OUT_FOR_DELIVERY' AND o."handoverId" IS NOT NULL GROUP BY 1, 2) h
    LEFT JOIN "StockLocation" sl ON sl.kind = 'DRIVER' AND sl."userId" = h."driverId"
    LEFT JOIN "StockBalance" b ON b."locationId" = sl.id AND b."variantId" = h."variantId"
    WHERE COALESCE(b.qty, 0) < h.held`;
  const [dbl] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT "orderId" FROM "HandoverOrder" WHERE "removedAt" IS NULL GROUP BY 1 HAVING count(*) > 1) x`;
  await db.$disconnect();
  console.log(`Шалгалт: тулгалтын зөрүү ${mis!.n}, сөрөг үлдэгдэл ${neg!.n}, хүргэлтийн бараа жолоочид дутуу ${short!.n}, 2 падаанд орсон захиалга ${dbl!.n}`);
  if (errors > 0 || mis!.n || neg!.n || short!.n || dbl!.n) process.exit(1);
}
main();
export {};
