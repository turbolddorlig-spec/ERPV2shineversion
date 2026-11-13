import { Prisma, type MoveType } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { reasonProblem, variantLabel } from '../../catalog/variants';
import type { UserActor } from '../users';

/**
 * Үлдэгдлийн журналын цөм (шийдвэр #38–#40).
 * Бараа хөдлөх БҮХ зам энд дамжина: журналын мөр (StockMove) + үлдэгдлийн хуулбар (StockBalance) нэг гүйлгээнд.
 * - Хасахдаа "qty >= n" нөхцөлтэй UPDATE — хүрэхгүй бол татгалзана (сөрөг үлдэгдэл боломжгүй, DB CHECK давхар хамгаална).
 * - Мөрүүдийг variantId-ийн дарааллаар түгжинэ — зэрэг гүйлгээнд deadlock үүсэхгүй.
 */
export type Tx = Prisma.TransactionClient;

export interface Line { variantId: number; qty: number }
export interface MoveSpec { type: MoveType; variantId: number; qty: number; fromId: number | null; toId: number | null; note?: string | null }

export const MAX_LINES = 500;
export const MAX_QTY = 100_000;

export const MOVE_LABEL: Record<MoveType, string> = {
  RECEIPT: 'Орлого',
  TRANSFER_SEND: 'Шилжүүлэг илгээсэн',
  TRANSFER_RECEIVE: 'Шилжүүлэг хүлээн авсан',
  TRANSFER_BACK: 'Шилжүүлэг буцсан',
  TRANSFER_LOSS: 'Шилжүүлгийн хорогдол',
  ISSUE: 'Зарлага',
  COUNT_PLUS: 'Тооллого (+)',
  COUNT_MINUS: 'Тооллого (−)',
  LOAN_OUT: 'Зээл олгосон',
  LOAN_RETURN: 'Зээл буцаасан',
  LOAN_CHARGE: 'Зээл — цалингаас суутгал',
  HANDOVER: 'Жолоочид өгсөн (падаан)',
  HANDOVER_BACK: 'Падаан буцаасан (жолоочоос)',
  DELIVERY: 'Хүргэсэн (үйлчлүүлэгчид)',
  DELIVERY_BACK: 'Хүргэсний дараа буцаасан (жолоочид)',
  DRIVER_RETURN: 'Жолоочоос буцаалт хүлээн авсан',
  EXTRA_OUT: 'Нэмэлт бараа жолоочид',
  EXTRA_SALE: 'Нэмэлт бараа зарсан',
};

export const ISSUE_REASON_LABEL = { DAMAGE: 'Гэмтэл', SAMPLE: 'Дээж, бэлэг, реклам', SUPPLIER_RETURN: 'Нийлүүлэгчид буцаасан' } as const;

/** Давхар дарахаас хамгаалах түлхүүр (дэлгэц нээгдэхэд үүснэ) */
export function cleanIdemKey(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(s)) throw badRequest('Хүсэлтийн түлхүүр буруу байна. Хуудсаа дахин ачаална уу.', 'idem_required');
  return s;
}

export function cleanNote(v: unknown, opts: { required?: boolean } = {}): string | null {
  const s = String(v ?? '').trim().slice(0, 500);
  if (opts.required) {
    const p = reasonProblem(s);
    if (p) throw badRequest(p, 'reason_required');
  }
  return s || null;
}

export function cleanId(v: unknown, label = 'Дугаар'): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw badRequest(`${label} буруу`);
  return n;
}

/** [{variantId, qty}] — бүхэл, эерэг, давхардсан хувилбарыг нэгтгэнэ, хувилбар байгаа эсэхийг шалгана */
export async function cleanLines(input: unknown, opts: { allowZero?: boolean; activeOnly?: boolean } = {}): Promise<{ lines: Line[]; labels: Map<number, string> }> {
  if (!Array.isArray(input) || input.length === 0) throw badRequest('Дор хаяж нэг бараа нэмнэ үү', 'no_lines');
  if (input.length > MAX_LINES) throw badRequest(`Нэг баримтад ${MAX_LINES} хүртэл мөр`);
  const merged = new Map<number, number>();
  for (const raw of input as { variantId?: unknown; qty?: unknown }[]) {
    const variantId = cleanId(raw?.variantId, 'Бараа');
    const qty = Number(raw?.qty);
    if (!Number.isInteger(qty) || qty < (opts.allowZero ? 0 : 1) || qty > MAX_QTY) throw badRequest(opts.allowZero ? 'Тоо 0 эсвэл түүнээс их бүхэл тоо байна' : 'Тоо 1-ээс их бүхэл тоо байна', 'bad_qty');
    merged.set(variantId, (merged.get(variantId) ?? 0) + qty);
  }
  const ids = [...merged.keys()];
  const labels = await variantLabels(ids);
  if (labels.size !== ids.length) throw badRequest('Бараа олдсонгүй', 'variant_not_found');
  // Аудит #143: архивласан / идэвхгүй бараанд орлого, шилжүүлэг хийхгүй (жагсаалтаас нуугдсан «далд нөөц» үүсэхээс сэргийлнэ)
  if (opts.activeOnly) {
    const bad = await db.productVariant.findMany({ where: { id: { in: ids }, OR: [{ isActive: false }, { product: { status: 'ARCHIVED' } }] }, select: { id: true } });
    if (bad.length) throw badRequest(`Идэвхгүй / архивласан бараа: ${bad.map((b) => labels.get(b.id)).join(', ')} — орлого, шилжүүлэг хийхгүй`, 'inactive_variant');
  }
  return { lines: ids.sort((a, b) => a - b).map((variantId) => ({ variantId, qty: merged.get(variantId)! })), labels };
}

/** Алдааны мессежэд: «0887-ХАР-38 Цагаан пүүз · Хар · 38» */
export async function variantLabels(ids: number[], tx: Tx | typeof db = db): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await tx.productVariant.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, color: true, size: true, product: { select: { name: true } } } });
  return new Map(rows.map((r) => [r.id, `${r.product.name}${r.color || r.size ? ` · ${variantLabel(r)}` : ''} (${r.code})`]));
}

// ───────────────────────── газрууд ─────────────────────────

let transitCache: number | null = null;
export async function transitLocationId(tx: Tx | typeof db = db): Promise<number> {
  if (transitCache) return transitCache;
  const l = await tx.stockLocation.findFirst({ where: { kind: 'TRANSIT' }, select: { id: true } });
  if (!l) throw new Error('TRANSIT location missing (migration)');
  transitCache = l.id;
  return l.id;
}

/** Идэвхтэй агуулахын газар */
export async function warehouseLocation(tx: Tx | typeof db, warehouseId: number, opts: { allowInactive?: boolean } = {}) {
  // Гүйлгээн дотор: агуулахыг хаах (FOR UPDATE) дуусахыг хүлээнэ — хаагдаж буй агуулахад бараа орохгүй (аудит А4)
  if (tx !== db) await tx.$queryRaw`SELECT id FROM "Warehouse" WHERE id = ${warehouseId} FOR SHARE`;
  const w = await tx.warehouse.findUnique({ where: { id: warehouseId }, include: { location: true } });
  if (!w || !w.location) throw notFound('Агуулах олдсонгүй');
  if (!w.isActive && !opts.allowInactive) throw badRequest(`«${w.name}» агуулах хаагдсан байна`);
  return { warehouse: w, locationId: w.location.id };
}

/** Ажилтны гарт (зээл) — хэрэгтэй үед үүснэ */
export async function staffLocationId(tx: Tx, staff: { id: string; name: string }): Promise<number> {
  const l = await tx.stockLocation.upsert({
    where: { kind_userId: { kind: 'STAFF', userId: staff.id } },
    create: { kind: 'STAFF', userId: staff.id, name: staff.name },
    update: {},
    select: { id: true },
  });
  return l.id;
}

// ───────────────────────── хөдөлгөөн ─────────────────────────

/**
 * Хөдөлгөөнүүдийг нэг гүйлгээнд бичнэ. Хүрэлцэхгүй бол бүх гүйлгээ буцна.
 * labels — алдааны мессежийн нэрс (байхгүй бол DB-ээс авна).
 */
/**
 * Аудит #147 (эзний шийдвэр): агуулах «Өгсөн» дарсан, жолооч хүлээн аваагүй (HANDED_OVER) падааны бараа — тавиураас гарсан,
 * жолоочид хүлээгдэж буй тул нөөцлөгдсөн. Систем дэх үлдэгдэл хэвээр (жолооч хүлээн авахад л журналаар шилжинэ), харин
 * тооллого, шилжүүлэг, зарлага, зээл, өөр падаан энэ барааг ашиглахгүй. Түлхүүр: `${locationId}:${variantId}`.
 */
export async function handedOverNeed(tx: Tx | typeof db, variantIds: number[], opts: { locationIds?: number[]; excludeHandoverId?: number } = {}): Promise<Map<string, number>> {
  const vids = [...new Set(variantIds)];
  if (!vids.length) return new Map();
  const ex = opts.excludeHandoverId ?? 0;
  const rows = await tx.$queryRaw<{ locationId: number; variantId: number; qty: number }[]>`
    SELECT l.id AS "locationId", x."variantId", sum(x.qty)::int AS qty FROM (
      SELECT h."warehouseId", ol."variantId", ol.qty FROM "Handover" h
        JOIN "HandoverOrder" ho ON ho."handoverId" = h.id AND ho."removedAt" IS NULL
        JOIN "OrderLine" ol ON ol."orderId" = ho."orderId"
        WHERE h.status = 'HANDED_OVER' AND h.id <> ${ex} AND ol."variantId" = ANY(${vids}::int[])
      UNION ALL
      SELECT h."warehouseId", dl."variantId", dl.qty FROM "Handover" h
        JOIN "DriverDoc" d ON d."handoverId" = h.id AND d.kind = 'EXTRA_TAKE' AND d.status = 'REQUESTED'
        JOIN "DriverDocLine" dl ON dl."docId" = d.id
        WHERE h.status = 'HANDED_OVER' AND h.id <> ${ex} AND dl."variantId" = ANY(${vids}::int[])
    ) x JOIN "StockLocation" l ON l."warehouseId" = x."warehouseId"
    ${opts.locationIds ? Prisma.sql`WHERE l.id = ANY(${opts.locationIds}::int[])` : Prisma.empty}
    GROUP BY l.id, x."variantId"`;
  return new Map(rows.map((r) => [`${r.locationId}:${r.variantId}`, r.qty]));
}

export async function applyMoves(tx: Tx, actor: { id: string; name: string }, doc: { type: string; id: number }, moves: MoveSpec[], labels?: Map<number, string>) {
  const list = moves.filter((m) => m.qty > 0).sort((a, b) => a.variantId - b.variantId || (a.fromId ?? 0) - (b.fromId ?? 0));
  // Аудит #143: хөдлөх бүх (байршил, бараа) мөрийг нэг дор, тогтмол дарааллаар түгжинэ — эсрэг чиглэлийн хоёр гүйлгээ
  // (жишээ нь шилжүүлэг илгээх ба хүлээн авах) бие биеэ хүлээж deadlock болохгүй
  const keys = [...new Set(list.flatMap((m) => [m.fromId, m.toId].filter((x): x is number => x !== null).map((l) => `${l}:${m.variantId}`)))];
  if (keys.length > 1) {
    const pairs = keys.map((k) => { const [l, v] = k.split(':').map(Number); return Prisma.sql`(${l}::int, ${v}::int)`; });
    await tx.$queryRaw`SELECT 1 FROM "StockBalance" WHERE ("locationId", "variantId") IN (${Prisma.join(pairs)}) ORDER BY "locationId", "variantId" FOR UPDATE`;
  }
  // Аудит #147: (байршил, бараа) тус бүрийн нийлбэрээр НЭГ хүсэлтээр — 120 бараатай падаан хүлээн авах 0.3 сек → хурдан
  const dec = new Map<string, { loc: number; v: number; q: number }>();
  const inc = new Map<string, { loc: number; v: number; q: number }>();
  for (const m of list) {
    if (m.fromId !== null) { const k = `${m.fromId}:${m.variantId}`; const e = dec.get(k) ?? { loc: m.fromId, v: m.variantId, q: 0 }; e.q += m.qty; dec.set(k, e); }
    if (m.toId !== null) { const k = `${m.toId}:${m.variantId}`; const e = inc.get(k) ?? { loc: m.toId, v: m.variantId, q: 0 }; e.q += m.qty; inc.set(k, e); }
  }
  if (dec.size) {
    const vals = [...dec.values()].map((d) => Prisma.sql`(${d.loc}::int, ${d.v}::int, ${d.q}::int)`);
    const done = await tx.$queryRaw<{ locationId: number; variantId: number }[]>`
      UPDATE "StockBalance" b SET "qty" = b."qty" - x.q, "updatedAt" = now()
      FROM (VALUES ${Prisma.join(vals)}) AS x(loc, v, q)
      WHERE b."locationId" = x.loc AND b."variantId" = x.v AND b."qty" >= x.q
      RETURNING b."locationId", b."variantId"`;
    if (done.length !== dec.size) {
      const ok = new Set(done.map((d) => `${d.locationId}:${d.variantId}`));
      const bad = [...dec.entries()].find(([k]) => !ok.has(k))![1];
      const have = (await tx.stockBalance.findUnique({ where: { locationId_variantId: { locationId: bad.loc, variantId: bad.v } } }))?.qty ?? 0;
      const loc = await tx.stockLocation.findUnique({ where: { id: bad.loc }, select: { name: true } });
      const name = labels?.get(bad.v) ?? (await variantLabels([bad.v], tx)).get(bad.v) ?? `#${bad.v}`;
      throw conflict(`«${name}» ${loc?.name ?? ''}-д хүрэлцэхгүй: байгаа ${have}, гаргах ${bad.q}`, 'insufficient_stock');
    }
  }
  if (inc.size) {
    const vals = [...inc.values()].sort((a, b) => a.loc - b.loc || a.v - b.v).map((d) => Prisma.sql`(${d.loc}::int, ${d.v}::int, ${d.q}::int, now())`);
    await tx.$executeRaw`
      INSERT INTO "StockBalance" ("locationId", "variantId", "qty", "updatedAt") VALUES ${Prisma.join(vals)}
      ON CONFLICT ("locationId", "variantId") DO UPDATE SET "qty" = "StockBalance"."qty" + EXCLUDED."qty", "updatedAt" = now()`;
  }
  // Аудит #147: агуулахаас гарах хөдөлгөөн (жолоочийн падаан хүлээн авахаас бусад) «Өгсөн» падааны барааг хөндөхгүй
  const outs = doc.type === 'handover' ? [] : list.filter((m) => m.fromId !== null);
  if (outs.length) {
    const ho = await handedOverNeed(tx, outs.map((m) => m.variantId), { locationIds: [...new Set(outs.map((m) => m.fromId!))] });
    if (ho.size) {
      const keys = [...ho.keys()].map((k) => k.split(':').map(Number) as [number, number]);
      const bals = await tx.stockBalance.findMany({ where: { OR: keys.map(([locationId, variantId]) => ({ locationId, variantId })) } });
      const bm = new Map(bals.map((b) => [`${b.locationId}:${b.variantId}`, b.qty]));
      const outKeys = new Set(outs.map((m) => `${m.fromId}:${m.variantId}`));
      const bad = [...ho].filter(([k, q]) => outKeys.has(k) && (bm.get(k) ?? 0) < q);
      if (bad.length) {
        const vl = await variantLabels(bad.map(([k]) => Number(k.split(':')[1])), tx);
        throw conflict(bad.map(([k, q]) => { const v = Number(k.split(':')[1]); const moved = outs.filter((m) => `${m.fromId}:${m.variantId}` === k).reduce((a, m) => a + m.qty, 0);
          return `«${labels?.get(v) ?? vl.get(v) ?? `#${v}`}»: ${q} ширхэг жолоочид өгөгдсөн (хүлээн авахыг хүлээж буй) — гаргах боломжтой ${Math.max(0, (bm.get(k) ?? 0) + moved - q)}`; }).join('; '), 'handed_over_stock');
      }
    }
  }
  if (list.length) {
    await tx.stockMove.createMany({
      data: list.map((m) => ({
        type: m.type, variantId: m.variantId, qty: m.qty, fromId: m.fromId, toId: m.toId,
        docType: doc.type, docId: doc.id, note: m.note ?? null, actorId: actor.id, actorName: actor.name,
      })),
    });
  }
}

/**
 * Аудит Б10 (эзний шийдвэр): захиалгад түгжигдсэн (нөөцлөгдсөн) барааг зарлагадах / өөр агуулах руу шилжүүлэхийг хориглоно.
 * Захиалах боломжтой = агуулахуудын нийт − бүх нөөцлөлт (захиалгатай ижил томьёо). Захиалга үүсгэхтэй ижил түгжээ (2, variant).
 */
/**
 * Аудит #143: орлого / шилжүүлэг — хувилбарын түгжээ (advisory 2) аваад идэвхтэй эсэхийг гүйлгээ дотор дахин шалгана
 * (архивлах үйлдэлтэй зэрэг ирвэл архивласан бараанд үлдэгдэл үүсэхгүй; архивлах ч мөн энэ түгжээг авна)
 */
export async function lockActiveVariants(tx: Tx, ids: number[], labels?: Map<number, string>) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  for (const id of sorted) await tx.$executeRaw`SELECT pg_advisory_xact_lock(2::int4, ${id}::int4)`;
  const bad = await tx.productVariant.findMany({ where: { id: { in: sorted }, OR: [{ isActive: false }, { product: { status: 'ARCHIVED' } }] }, select: { id: true } });
  if (bad.length) throw badRequest(`Идэвхгүй / архивласан бараа: ${bad.map((b) => labels?.get(b.id) ?? `#${b.id}`).join(', ')} — орлого, шилжүүлэг хийхгүй`, 'inactive_variant');
}

/** Б10: бараа (advisory 2) түгжээг хөдөлгөөний ӨМНӨ авна — захиалгын урсгалтай ижил дараалал (deadlock гарахгүй) */
export async function lockReservedVariants(tx: Tx, lines: { variantId: number }[]) {
  for (const id of [...new Set(lines.map((l) => l.variantId))].sort((a, b) => a - b)) await tx.$executeRaw`SELECT pg_advisory_xact_lock(2::int4, ${id}::int4)`;
}

export async function assertNotReserved(tx: Tx, lines: { variantId: number; qty: number }[], labels?: Map<number, string>, afterMoves = false) {
  const ids = [...new Set(lines.map((l) => l.variantId))].sort((a, b) => a - b);
  if (!ids.length) return;
  for (const id of ids) await tx.$executeRaw`SELECT pg_advisory_xact_lock(2::int4, ${id}::int4)`;
  const rows = await tx.$queryRaw<{ variantId: number; total: number; reserved: number }[]>`
    SELECT v.id AS "variantId",
      COALESCE((SELECT sum(b.qty) FROM "StockBalance" b JOIN "StockLocation" l ON l.id = b."locationId" AND l.kind = 'WAREHOUSE' WHERE b."variantId" = v.id), 0)::int AS total,
      COALESCE((SELECT sum(r.qty) FROM "StockReservation" r WHERE r."variantId" = v.id), 0)::int AS reserved
    FROM "ProductVariant" v WHERE v.id IN (${Prisma.join(ids)})`;
  const need = new Map<number, number>();
  for (const l of lines) need.set(l.variantId, (need.get(l.variantId) ?? 0) + l.qty);
  // afterMoves: хөдөлгөөний дараа шалгана (үлдэгдэл хүрэхгүй бол эхлээд insufficient_stock гарна)
  const before = (r: { variantId: number; total: number }) => r.total + (afterMoves ? need.get(r.variantId) ?? 0 : 0);
  const bad = rows.filter((r) => r.reserved > 0 && (need.get(r.variantId) ?? 0) > before(r) - r.reserved);
  if (bad.length) {
    throw conflict(bad.map((r) => `«${labels?.get(r.variantId) ?? `#${r.variantId}`}»: ${r.reserved} ширхэг захиалгад түгжигдсэн, гаргах боломжтой ${Math.max(0, before(r) - r.reserved)}`).join('; '), 'reserved_stock');
  }
}

export function uniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/** «Өнөөдрийн ажил»-ын санах ой — үлдэгдэл өөрчлөгдөх бүрт цэвэрлэнэ */
export const stockCache: { today: { at: number; data: unknown } | null } = { today: null };

/** Сериализацийн/deadlock алдаанд нэг удаа дахин оролдоно */
export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      // Аудит #149: түгжээ 8 сек-ээс удаан хүлээхгүй («Систем түр завгүй») — нэг бараа түгжигдэхэд бүх холболт эзлэгдэж систем гацахгүй
      const r = await db.$transaction(async (tx) => { await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`; return fn(tx); }, { timeout: 20_000, maxWait: 10_000 });
      stockCache.today = null;
      return r;
    } catch (e) {
      const code = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : '';
      if (attempt < 2 && (code === 'P2034' || /deadlock detected/i.test(String((e as Error)?.message)))) continue;
      throw e;
    }
  }
}

// ───────────────────────── тохиргоо ─────────────────────────

export async function getSettingNumber(key: string, fallback: number): Promise<number> {
  const r = await db.appSetting.findUnique({ where: { key } });
  const n = Number(r?.value);
  return Number.isFinite(n) ? n : fallback;
}

export function requireRole(ok: boolean, msg?: string) {
  if (!ok) throw forbidden(msg);
}

export type { UserActor };

/** Давтагдах үйлдлийн давхар даралтаас хамгаална: түлхүүр шинэ бол true, өмнө нь хэрэглэгдсэн бол false */
export async function claimIdem(tx: Tx, key: string): Promise<boolean> {
  const n = await tx.$executeRaw`INSERT INTO "IdemKey" ("key") VALUES (${key}) ON CONFLICT DO NOTHING`;
  return n > 0;
}
