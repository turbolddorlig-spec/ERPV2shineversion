/**
 * Модуль 4 (падаан) ачаалал: 1,000,000+ захиалгатай үед 150 хэрэглэгч ЗЭРЭГ.
 * Ахлах жолооч: жагсаалт (шүүлтүүр), жолооч бүрийн захиалга, БОДИТ хуваарилалт/огноо солих;
 * агуулах: жолооч сонгох самбар, жолоочийн өдөр, падааны дэлгэрэнгүй, түүх; бусад: захиалгын жагсаалт (жолоочоор шүүх).
 * Төгсгөлд: тулгалт (журнал = үлдэгдэл), сөрөг үлдэгдэл 0, нэг захиалга 2 идэвхтэй падаанд 0.
 */
import { PrismaClient } from '@prisma/client';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const USERS = Number(process.env.LOAD_USERS ?? 150);
const ITER = Number(process.env.LOAD_ITER ?? 8);
const THINK = Number(process.env.THINK_MS ?? 0);
const think = () => (THINK > 0 ? new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random()))) : Promise.resolve());
const lat: Record<string, number[]> = {};
let errors = 0; let rejected = 0;
const samples: string[] = [];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const ub = (add = 0) => new Date(Date.now() + 8 * 3600_000 + add * 86_400_000).toISOString().slice(0, 10);

async function hit(kind: string, path: string, cookie: string, body?: unknown) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await r.text();
    (lat[kind] ??= []).push(performance.now() - t0);
    if (r.status === 409) rejected++;
    else if (r.status >= 400 && r.status !== 403) { errors++; if (samples.length < 6) samples.push(`${kind} ${r.status} ${text.slice(0, 80)}`); }
    return { status: r.status, text };
  } catch (e) { errors++; if (samples.length < 6) samples.push(`${kind} ${(e as Error).message}`); return null; }
}
async function login(phone: string) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: 'Test1234' }) });
  await r.text();
  const m = /zs=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  return m ? `zs=${m[1]}` : null;
}

// seed-test-data: 80000026–27 ахлах жолооч, 80000028 ахлах жолооч+агуулах, 80000132–138 агуулах, 80000002–03 админ
const LEADS = ['80000026', '80000027', '80000028'];
const WAREHOUSE = ['80000132', '80000133', '80000134', '80000135', '80000136', '80000137', '80000138'];

async function lead(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  const drivers = JSON.parse((await hit('жолоочийн жагсаалт', '/api/driver-lead/drivers', c))?.text ?? '{"items":[]}').items as { id: string }[];
  for (let k = 0; k < ITER; k++) {
    await think(); const l = await hit('ахлах: жагсаалт', `/api/driver-lead/orders?assign=${pick(['unassigned', 'assigned', 'all'])}&pageSize=${pick([20, 50, 100])}`, c);
    await think(); await hit('ахлах: шүүлтүүр', `/api/driver-lead/orders?assign=all&${pick(['rural=1', 'district=%D0%91%D0%B0%D1%8F%D0%BD%D0%B7%D2%AF%D1%80%D1%85', `deliveryDate=${ub()}`, 'q=9912'])}`, c);
    const items = l ? (JSON.parse(l.text).items ?? []) as { id: number; status: string }[] : [];
    const free = items.filter((o) => o.status === 'NEW').slice(0, 5).map((o) => o.id);
    if (free.length && drivers.length) { await think(); await hit('ахлах: хуваарилах', '/api/driver-lead/assign', c, { ids: free, driverId: pick(drivers).id }); }
    if (k % 3 === 0 && free.length) { await think(); await hit('ахлах: огноо солих', '/api/driver-lead/assign', c, { ids: free.slice(0, 2), date: ub(1) }); }
    await think(); await hit('ахлах: жолоочдын захиалга', `/api/driver-lead/drivers?byDay=1&date=${ub()}`, c);
  }
}
async function warehouse(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); const b = await hit('агуулах: жолооч самбар', `/api/handover?date=${pick([ub(), ub(1)])}`, c);
    const drv = b ? (JSON.parse(b.text).drivers ?? []) as { id: string; handover: { id: number } | null }[] : [];
    const d = drv.length ? pick(drv) : null;
    if (d) { await think(); await hit('агуулах: жолоочийн өдөр', `/api/handover?driverId=${d.id}&date=${ub()}`, c); }
    const withH = drv.filter((x) => x.handover);
    if (withH.length) { await think(); await hit('агуулах: падаан', `/api/handover/${pick(withH).handover!.id}`, c); }
    await think(); await hit('агуулах: түүх', '/api/handover?history=1', c);
  }
}
async function viewer(phone: string) {
  const c = await login(phone); if (!c) { errors++; return; }
  for (let k = 0; k < ITER; k++) {
    await think(); await hit('захиалга (жолоочоор)', `/api/orders?statuses=${pick(['ASSIGNED', 'OUT_FOR_DELIVERY', ''])}`, c);
    await think(); await hit('хуудас /driver-lead', '/driver-lead', c);
  }
}

async function main() {
  const t0 = performance.now();
  const others = Array.from({ length: USERS }, (_, i) => String(80000001 + i)).filter((p) => !LEADS.includes(p) && !WAREHOUSE.includes(p));
  const jobs = [...LEADS.map(lead), ...WAREHOUSE.map(warehouse), ...others.slice(0, USERS - LEADS.length - WAREHOUSE.length).map(viewer)];
  await Promise.all(jobs);
  const secs = (performance.now() - t0) / 1000;
  const total = Object.values(lat).reduce((n, a) => n + a.length, 0);
  console.log(`\nПадааны ачаалал (${THINK > 0 ? `хүний хурд ~${THINK}мс` : 'завсаргүй стресс'}): ${jobs.length} зэрэг хэрэглэгч — ${total} хүсэлт, ${secs.toFixed(1)} сек`);
  console.log('Төрөл                          тоо     p50     p95     p99   (мс)');
  for (const [k, a] of Object.entries(lat)) console.log(`${k.padEnd(28)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)}`);
  console.log(`Бизнесийн татгалзал (409): ${rejected}; алдаа: ${errors}${samples.length ? '\n  ' + samples.join('\n  ') : ''}`);
  const db = new PrismaClient();
  const [neg] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "StockBalance" WHERE qty < 0`;
  const [dbl] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT "orderId" FROM "HandoverOrder" WHERE "removedAt" IS NULL GROUP BY 1 HAVING count(*) > 1) x`;
  const [mis] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT b."locationId", b."variantId", b.qty, COALESCE(m.q, 0) AS q FROM "StockBalance" b
      LEFT JOIN (SELECT loc, "variantId", sum(q) AS q FROM (SELECT "toId" AS loc, "variantId", qty AS q FROM "StockMove" WHERE "toId" IS NOT NULL
        UNION ALL SELECT "fromId", "variantId", -qty FROM "StockMove" WHERE "fromId" IS NOT NULL) z GROUP BY 1, 2) m ON m.loc = b."locationId" AND m."variantId" = b."variantId"
      WHERE b.qty <> COALESCE(m.q, 0)) x`;
  const [assignedNoDriver] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Order" WHERE status IN ('ASSIGNED','OUT_FOR_DELIVERY') AND "driverId" IS NULL`;
  await db.$disconnect();
  console.log(`Шалгалт: тулгалтын зөрүү ${mis!.n}, сөрөг үлдэгдэл ${neg!.n}, 2 падаанд орсон захиалга ${dbl!.n}, жолоочгүй оноосон ${assignedNoDriver!.n}`);
  if (errors > 0 || mis!.n || neg!.n || dbl!.n || assignedNoDriver!.n) process.exit(1);
}
main();
export {};
