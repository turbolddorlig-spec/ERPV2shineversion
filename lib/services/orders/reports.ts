import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden } from '../../errors';
import { canView } from '../../permissions';
import { ubDay, ubDayStart, isYmd } from '../../ubdate';
import { CLOSE_LABEL } from './calls';
import type { UserActor } from './core';

/** Тайлан: Супер админ, Ахлах маркетинг, Маркетинг (#53, #54) */
const assertReports = (a: UserActor) => { if (!canView(a.roles, 'reports')) throw forbidden('Тайланг Супер админ, маркетинг харна'); };

function range(from?: string, to?: string) {
  const f = from && isYmd(from) ? from : ubDay(new Date(), -6);
  const t = to && isYmd(to) ? to : ubDay();
  if (f > t) throw badRequest('Эхлэх огноо дуусахаас хойш байна');
  const days = (Date.parse(t) - Date.parse(f)) / 86_400_000;
  if (days > 370) throw badRequest('Хугацаа 1 жилээс ихгүй');
  return { from: f, to: t, start: ubDayStart(f), end: new Date(ubDayStart(t).getTime() + 86_400_000) };
}

/**
 * Пэйжийн тайлан (#47, #53) — зөвхөн тоо (мөнгөн дүн байхгүй).
 * Захиалга = үүссэн өдрөөр; Баталгаажсан = баталгаажсан өдрөөр; Цуцлагдсан = цуцалсан өдрөөр; Хүргэсэн = хүргэсэн өдрөөр (B1).
 */
export async function pageReport(actor: UserActor, p: { from?: string; to?: string; pageId?: number; by?: string }) {
  assertReports(actor);
  const r = range(p.from, p.to);
  const pf = p.pageId ? Prisma.sql`AND "pageId" = ${p.pageId}` : Prisma.empty;
  const groupCol = p.by === 'operator' ? Prisma.sql`"operatorName"` : p.by === 'day' ? Prisma.sql`to_char("ts" AT TIME ZONE 'Asia/Ulaanbaatar', 'YYYY-MM-DD')` : Prisma.sql`"pageId"::text`;
  const rows = await db.$queryRaw<{ k: string; metric: string; n: number }[]>`
    WITH ev AS (
      SELECT "pageId", "operatorName", 'created' AS metric, "createdAt" AS ts FROM "Order" WHERE "createdAt" >= ${r.start} AND "createdAt" < ${r.end} ${pf}
      UNION ALL SELECT "pageId", "operatorName", 'confirmed', "confirmedAt" FROM "Order" WHERE "confirmedAt" >= ${r.start} AND "confirmedAt" < ${r.end} ${pf}
      UNION ALL SELECT "pageId", "operatorName", 'cancelled', "cancelledAt" FROM "Order" WHERE "cancelledAt" >= ${r.start} AND "cancelledAt" < ${r.end} ${pf}
      UNION ALL SELECT "pageId", "operatorName", 'delivered', "deliveredAt" FROM "Order" WHERE "deliveredAt" >= ${r.start} AND "deliveredAt" < ${r.end} ${pf})
    SELECT ${groupCol} AS k, metric, count(*)::int AS n FROM ev GROUP BY 1, 2`;
  const pages = new Map((await db.page.findMany({ select: { id: true, name: true } })).map((x) => [String(x.id), x.name]));
  const agg = new Map<string, { key: string; label: string; created: number; confirmed: number; cancelled: number; delivered: number }>();
  for (const x of rows) {
    const e = agg.get(x.k) ?? { key: x.k, label: p.by === 'operator' || p.by === 'day' ? x.k : pages.get(x.k) ?? `#${x.k}`, created: 0, confirmed: 0, cancelled: 0, delivered: 0 };
    (e as unknown as Record<string, number>)[x.metric] = x.n;
    agg.set(x.k, e);
  }
  const list = [...agg.values()].sort((a, b) => (p.by === 'day' ? a.key.localeCompare(b.key) : b.confirmed - a.confirmed));
  const total = list.reduce((a, e) => ({ created: a.created + e.created, confirmed: a.confirmed + e.confirmed, cancelled: a.cancelled + e.cancelled, delivered: a.delivered + e.delivered }), { created: 0, confirmed: 0, cancelled: 0, delivered: 0 });
  return { from: r.from, to: r.to, by: p.by ?? 'page', pageId: p.pageId ?? null, rows: list, total };
}

/** Пэйжийн бараагаар (ширхэг) — баталгаажсан захиалгаар */
export async function pageProducts(actor: UserActor, p: { from?: string; to?: string; pageId?: number }) {
  assertReports(actor);
  const r = range(p.from, p.to);
  const pf = p.pageId ? Prisma.sql`AND o."pageId" = ${p.pageId}` : Prisma.empty;
  return db.$queryRaw<{ code: string; name: string; label: string; qty: number; orders: number }[]>`
    SELECT l.code, max(l.name) AS name, max(l.label) AS label, sum(l.qty)::int AS qty, count(DISTINCT o.id)::int AS orders
    FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId"
    WHERE o."confirmedAt" >= ${r.start} AND o."confirmedAt" < ${r.end} AND o.status <> 'CANCELLED' ${pf}
    GROUP BY l.code ORDER BY qty DESC LIMIT 100`;
}

/**
 * Дуудлагын шинжилгээ (#54): хугацааны бүх тэмдэглэл — захиалга болсон (аль ч утас/пэйж/бараагаар, тэмдэглэлээс хойш) уу,
 * болоогүй бол шалтгаан. 3 хоногоос дээш хаагдаагүй → «Шалтгаангүй».
 */
export async function callAnalysis(actor: UserActor, p: { from?: string; to?: string; by?: string; bucket?: string }) {
  assertReports(actor);
  const r = range(p.from, p.to);
  const stale = new Date(Date.now() - 3 * 86_400_000);
  const rows = await db.$queryRaw<{ id: number; phone: string; pageId: number | null; variantId: number | null; productText: string | null; ownerName: string; status: string; closeReason: string | null; createdAt: Date; converted: boolean }[]>`
    SELECT n.id, n.phone, n."pageId", n."variantId", n."productText", n."ownerName", n.status::text, n."closeReason"::text AS "closeReason", n."createdAt",
      (n.status = 'ORDERED' OR EXISTS (SELECT 1 FROM "Order" o WHERE (o.phone = n.phone OR o."extraPhone" = n.phone) AND o."createdAt" >= n."createdAt")) AS converted
    FROM "CallNote" n WHERE n."createdAt" >= ${r.start} AND n."createdAt" < ${r.end} ORDER BY n.id DESC LIMIT 20000`;
  const bucketOf = (x: (typeof rows)[number]) => (x.converted ? 'CONVERTED' : x.closeReason ? x.closeReason : x.createdAt < stale ? 'NONE' : 'OPEN');
  const LABEL: Record<string, string> = { CONVERTED: 'Захиалга болсон', NONE: 'Шалтгаангүй', OPEN: 'Залгаж байгаа', ...CLOSE_LABEL };
  const vids = [...new Set(rows.map((x) => x.variantId).filter((v): v is number => !!v))];
  const [variants, pages] = await Promise.all([
    vids.length ? db.productVariant.findMany({ where: { id: { in: vids } }, select: { id: true, code: true, product: { select: { name: true } } } }) : [],
    db.page.findMany({ select: { id: true, name: true } }),
  ]);
  const vn = new Map(variants.map((v) => [v.id, `${v.product.name} (${v.code})`]));
  const pn = new Map(pages.map((x) => [x.id, x.name]));
  const dim = (x: (typeof rows)[number]) => p.by === 'page' ? (x.pageId ? pn.get(x.pageId) ?? '—' : '—') : p.by === 'product' ? (x.variantId ? vn.get(x.variantId) ?? '—' : x.productText ?? '—') : p.by === 'operator' ? x.ownerName : 'all';
  const summary = new Map<string, number>();
  const table = new Map<string, Record<string, number>>();
  for (const x of rows) {
    const b = bucketOf(x);
    summary.set(b, (summary.get(b) ?? 0) + 1);
    if (p.by) { const d = dim(x); const t = table.get(d) ?? {}; t[b] = (t[b] ?? 0) + 1; t.total = (t.total ?? 0) + 1; table.set(d, t); }
  }
  const total = rows.length;
  return {
    from: r.from, to: r.to, total, converted: summary.get('CONVERTED') ?? 0,
    buckets: [...summary.entries()].map(([k, n]) => ({ key: k, label: LABEL[k] ?? k, n, pct: total ? Math.round((n / total) * 1000) / 10 : 0 })).sort((a, b) => (a.key === 'CONVERTED' ? -1 : b.key === 'CONVERTED' ? 1 : b.n - a.n)),
    by: p.by ?? null,
    table: [...table.entries()].map(([k, v]) => ({ key: k, ...v } as { key: string; total?: number } & Record<string, number | string>)).sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0)).slice(0, 200),
    phones: p.bucket ? rows.filter((x) => bucketOf(x) === p.bucket).slice(0, 2000).map((x) => ({ phone: x.phone, product: x.variantId ? vn.get(x.variantId) ?? null : x.productText, page: x.pageId ? pn.get(x.pageId) ?? null : null, operator: x.ownerName, createdAt: x.createdAt })) : [],
    labels: LABEL,
  };
}
