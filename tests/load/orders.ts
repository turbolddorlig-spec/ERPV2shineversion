/**
 * Захиалгын ачааллын тест (R1): 1,000,000+ захиалгатай үед 150 хэрэглэгч ЗЭРЭГ.
 * Операторууд (22): жагсаалт, таб, хайлт, үйлчлүүлэгчийн карт, бараа хайх, цагийн мэдээ + БОДИТ захиалга үүсгэх/засах/цуцлах
 *   (зарим нь санаатай давхар даралт — нэг л үүснэ). Бусад: жагсаалт, захиалга харах; СА/маркетинг: тайлан.
 * Төгсгөлд: давхар захиалга 0, нөөц = идэвхтэй захиалгын мөр, үлдэгдэл сөрөг 0 гэдгийг шалгана.
 */
import { PrismaClient } from '@prisma/client';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const USERS = Number(process.env.LOAD_USERS ?? 150);
const ITER = Number(process.env.LOAD_ITER ?? 10);
const THINK = Number(process.env.THINK_MS ?? 0);
const think = () => (THINK > 0 ? new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random()))) : Promise.resolve());
const lat: Record<string, number[]> = {};
let errors = 0; let rejected = 0; let created = 0;
const samples: string[] = [];
const WORDS = ['Зайсан', 'тоот', 'пүүз', 'Баянзүрх', '9912', '0050', 'Хар', 'Нарны'];

async function hit(kind: string, path: string, cookie: string, init?: { method?: string; body?: unknown }) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { method: init?.method ?? (init?.body ? 'POST' : 'GET'), headers: { cookie, 'content-type': 'application/json' }, body: init?.body ? JSON.stringify(init.body) : undefined, redirect: 'manual' });
    const text = await r.text();
    (lat[kind] ??= []).push(performance.now() - t0);
    // 403 = эрхгүй хуудас (жолооч гэх мэт) — хүлээгдэж буй. 409 (давхардал, үлдэгдэл хүрэлцэхгүй, хуучин хувилбар) — бизнесийн зөв хариу
    if (r.status === 409) rejected++;
    else if (r.status >= 400 && r.status !== 403) { errors++; if (samples.length < 6) samples.push(`${kind} ${r.status} ${text.slice(0, 80)}`); }
    return { status: r.status, text };
  } catch (e) { errors++; if (samples.length < 6) samples.push(`${kind} ${(e as Error).message}`); return null; }
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

async function login(phone: string) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: 'Test1234' }) });
  await r.text();
  const m = /zs=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  return m ? `zs=${m[1]}` : null;
}

// seed-test-data дарааллаар: 80000004–05 ахлах оператор, 80000006–25 оператор, 80000001 СА, 80000139–146 маркетинг
const OPS = Array.from({ length: 22 }, (_, i) => String(80000004 + i));
const REPORTERS = ['80000001', '80000139', '80000140', '80000141'];

async function operator(phone: string, n: number) {
  const cookie = await login(phone); if (!cookie) { errors++; return; }
  const pages = JSON.parse((await hit('пэйж', '/api/orders/pages', cookie))?.text ?? '{"pages":[]}').pages as { id: number }[];
  for (let k = 0; k < ITER; k++) {
    await think(); await hit('жагсаалт (өнөөдөр)', '/api/orders?tab=today', cookie);
    await think(); await hit('жагсаалт (таб)', `/api/orders?tab=${pick(['NEW', 'PENDING_PAYMENT', 'ASSIGNED', 'DELIVERED', 'CANCELLED', 'all'])}&page=${1 + (k % 3)}`, cookie);
    await think(); await hit('хайлт', `/api/orders?q=${encodeURIComponent(pick(WORDS))}`, cookie);
    const phoneNo = '9' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
    await think(); await hit('үйлчлүүлэгчийн карт', `/api/orders/customer?phone=${phoneNo}`, cookie);
    await think(); const s = await hit('бараа хайх', `/api/products/search?q=${encodeURIComponent(pick(['пүүз', 'цамц', 'Хар', '00', 'тос']))}&limit=12`, cookie);
    const hits = s ? (JSON.parse(s.text).items as { variantId: number; available: number }[]).filter((h) => h.available > 0) : [];
    if (hits.length && pages.length) {
      const body = { phone: phoneNo, province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: 1 + (k % 20), addressDetail: `Ачаалал ${n}-${k} байр`, pageId: pick(pages).id, lines: [{ variantId: pick(hits).variantId, qty: 1 }], idemKey: `load-${phone}-${k}-${Date.now()}` };
      await think();
      // Зарим удаа давхар дарна (сүлжээ тасрах / давхар товшилт)
      const rs = k % 4 === 0 ? await Promise.all([hit('захиалга үүсгэх', '/api/orders', cookie, { body }), hit('захиалга үүсгэх', '/api/orders', cookie, { body })]) : [await hit('захиалга үүсгэх', '/api/orders', cookie, { body })];
      const o = rs.map((r) => (r && r.status < 300 ? JSON.parse(r.text) : null)).find(Boolean) as { order: { id: number; version: number } } | undefined;
      if (o) {
        created++;
        await think(); const d = await hit('захиалга харах', `/api/orders/${o.order.id}`, cookie);
        const ver = d ? JSON.parse(d.text).order?.version : o.order.version;
        if (k % 3 === 0) { await think(); await hit('захиалга засах', `/api/orders/${o.order.id}`, cookie, { method: 'PATCH', body: { version: ver, note: 'Ачааллын засвар' } }); }
        if (k % 5 === 1) { await think(); await hit('цуцлах', `/api/orders/${o.order.id}/cancel`, cookie, { body: { reason: 'CUSTOMER_CANCELLED', note: 'Ачааллын цуцлалт', version: ver + (k % 3 === 0 ? 1 : 0) } }); }
      }
    }
    await think(); await hit('цагийн мэдээ', '/api/orders/hourly', cookie);
    await think(); await hit('дуудлага', '/api/calls', cookie);
  }
}

async function viewer(phone: string) {
  const cookie = await login(phone); if (!cookie) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); await hit('хуудас /orders', '/orders', cookie);
    await think(); await hit('жагсаалт (таб)', `/api/orders?tab=${pick(['today', 'NEW', 'ASSIGNED', 'all'])}`, cookie);
    await think(); await hit('захиалга харах', `/api/orders/${1 + Math.floor(Math.random() * 1_000_000)}`, cookie);
  }
}

async function reporter(phone: string) {
  const cookie = await login(phone); if (!cookie) { errors++; return; }
  for (let k = 0; k < Math.ceil(ITER / 2); k++) {
    await think(); await hit('пэйжийн тайлан (7 хоног)', `/api/reports/pages?by=${pick(['page', 'operator', 'day', 'product'])}`, cookie);
    await think(); await hit('дуудлагын шинжилгээ', `/api/reports/calls?by=${pick(['', 'page', 'operator'])}`, cookie);
  }
}

async function main() {
  const t0 = performance.now();
  const others = Array.from({ length: USERS }, (_, i) => String(80000001 + i)).filter((p) => !OPS.includes(p) && !REPORTERS.includes(p));
  const jobs = [...OPS.map((p, i) => operator(p, i)), ...REPORTERS.map(reporter), ...others.slice(0, Math.max(0, USERS - OPS.length - REPORTERS.length)).map((p) => viewer(p))];
  await Promise.all(jobs);
  const secs = (performance.now() - t0) / 1000;
  const total = Object.values(lat).reduce((n, a) => n + a.length, 0);
  console.log(`\nЗахиалгын ачаалал (${THINK > 0 ? `хүний хурд ~${THINK}мс` : 'завсаргүй стресс'}): ${jobs.length} зэрэг хэрэглэгч — ${total} хүсэлт, ${secs.toFixed(1)} сек (${(total / secs).toFixed(0)}/сек)`);
  console.log('Төрөл                          тоо     p50     p95     p99   (мс)');
  for (const [k, a] of Object.entries(lat)) console.log(`${k.padEnd(28)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)}`);
  console.log(`Үүссэн захиалга: ${created}; бизнесийн татгалзал (409): ${rejected}; алдаа: ${errors}${samples.length ? '\n  ' + samples.join('\n  ') : ''}`);

  // Бүрэн бүтэн байдал
  const db = new PrismaClient();
  const [dups] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT phone FROM "Order" WHERE status IN ('PENDING_PAYMENT','NEW','ASSIGNED') AND "idemKey" LIKE 'load-%' GROUP BY phone HAVING count(*) > 1) x`;
  const [resv] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT l."orderId", l."variantId", l.qty, r.qty AS rq FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId"
      LEFT JOIN "StockReservation" r ON r."orderId" = l."orderId" AND r."variantId" = l."variantId"
      WHERE o."idemKey" LIKE 'load-%' AND o.status IN ('PENDING_PAYMENT','NEW','ASSIGNED') AND (r.qty IS NULL OR r.qty <> l.qty)
      UNION ALL SELECT r."orderId", r."variantId", 0, r.qty FROM "StockReservation" r JOIN "Order" o ON o.id = r."orderId" WHERE o."idemKey" LIKE 'load-%' AND o.status = 'CANCELLED') x`;
  const [neg] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "StockBalance" WHERE qty < 0`;
  await db.$disconnect();
  console.log(`Шалгалт: давхар идэвхтэй захиалга ${dups!.n}, нөөцийн зөрүү ${resv!.n}, сөрөг үлдэгдэл ${neg!.n}`);
  if (errors > 0 || dups!.n || resv!.n || neg!.n) process.exit(1);
}
main();
export {};
