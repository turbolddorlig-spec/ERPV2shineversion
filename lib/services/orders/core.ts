import { Prisma, type CancelReason, type OrderStatus } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict } from '../../errors';
import { normalizePhone, isValidPhone } from '../../phone';
import { PROVINCES, UB_DISTRICTS, isUB } from '../../geo';
import { reasonProblem } from '../../catalog/variants';
import { ubDay, isYmd, dateOnly } from '../../ubdate';
import { getSettingNumber } from '../stock/core';
import type { UserActor } from '../users';

export type Tx = Prisma.TransactionClient;
export type { UserActor };

/** Хүргэлтэд гараагүй, идэвхтэй — давхардал, засвар, нөөцөд хамаарна */
export const ACTIVE: OrderStatus[] = ['PENDING_PAYMENT', 'NEW', 'ASSIGNED'];

/** Дэлгэцэнд харагдах 7 төлөв (#44, #45). SCHEDULED = NEW + хүргэх өдөр маргаашаас хойш */
export type DisplayStatus = OrderStatus | 'SCHEDULED';
export const STATUS_LABEL: Record<DisplayStatus, string> = {
  PENDING_PAYMENT: 'Төлбөр хүлээж буй',
  SCHEDULED: 'Он сар өдөртэй',
  NEW: 'Шинэ',
  ASSIGNED: 'Жолоочид оноосон',
  OUT_FOR_DELIVERY: 'Хүргэлтэд гарсан',
  DELIVERED: 'Хүргэсэн',
  CANCELLED: 'Цуцлагдсан',
};
export const CANCEL_LABEL: Record<CancelReason, string> = {
  CUSTOMER_CANCELLED: 'Үйлчлүүлэгч болисон',
  DUPLICATE: 'Давхар захиалга',
  OUT_OF_STOCK: 'Бараа дутуу',
  NO_ANSWER: 'Утас авахгүй',
  PAYMENT_TIMEOUT: 'Төлбөрийн хугацаа дууссан',
  OTHER: 'Бусад',
  DRIVER_CANCELLED: 'Жолооч цуцалсан',
  ISSUE: 'Асуудлаар цуцлагдсан',
};

export function displayStatus(o: { status: OrderStatus; deliveryDate: Date }, tomorrow = ubDay(new Date(), 1)): DisplayStatus {
  if (o.status === 'NEW' && o.deliveryDate.toISOString().slice(0, 10) > tomorrow) return 'SCHEDULED';
  return o.status;
}

// ───────────────────────── тохиргоо ─────────────────────────

export const SETTINGS = { feeUB: 'deliveryFeeUB', feeRural: 'deliveryFeeRural', waitDays: 'paymentWaitDays', assignHour: 'assignDeadlineHour' } as const;
export async function orderSettings() {
  const [feeUB, feeRural, waitDays, assignHour] = await Promise.all([
    getSettingNumber(SETTINGS.feeUB, 5000), getSettingNumber(SETTINGS.feeRural, 10000), getSettingNumber(SETTINGS.waitDays, 7),
    // Өнөөдрийн «Шинэ» захиалгыг хуваарилж дуусгах цаг (#124-4): энэ цагаас хойш хуваарилагдаагүй бол 🔴
    getSettingNumber(SETTINGS.assignHour, 21),
  ]);
  return { feeUB, feeRural, waitDays, assignHour };
}

// ───────────────────────── оруулга цэвэрлэх ─────────────────────────

export function cleanPhone(v: unknown, label = 'Утас'): string {
  const p = normalizePhone(String(v ?? ''));
  if (!isValidPhone(p)) throw badRequest(`${label} 8 оронтой тоо байх ёстой`, 'bad_phone');
  return p;
}
export function cleanOptPhone(v: unknown): string | null {
  const s = normalizePhone(String(v ?? ''));
  if (!s) return null;
  if (!isValidPhone(s)) throw badRequest('Нэмэлт утас 8 оронтой тоо байх ёстой', 'bad_phone');
  return s;
}

export function cleanAddress(input: { province?: unknown; district?: unknown; khoroo?: unknown; addressDetail?: unknown }) {
  const province = String(input.province ?? '').trim();
  if (!PROVINCES.includes(province)) throw badRequest('Аймаг / хотоо сонгоно уу', 'bad_province');
  let district: string | null = null;
  let khoroo: number | null = null;
  if (isUB(province)) {
    district = String(input.district ?? '').trim();
    if (!(district in UB_DISTRICTS)) throw badRequest('Дүүргээ сонгоно уу', 'bad_district');
    if (input.khoroo !== undefined && input.khoroo !== null && input.khoroo !== '') {
      khoroo = Number(input.khoroo);
      if (!Number.isInteger(khoroo) || khoroo < 1 || khoroo > UB_DISTRICTS[district]!) throw badRequest('Хороо буруу', 'bad_khoroo');
    }
  }
  let addressDetail = String(input.addressDetail ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (isUB(province)) {
    if (addressDetail.length < 2) throw badRequest('Дэлгэрэнгүй хаяг (байр, орц, тоот) бичнэ үү', 'bad_address');
  }
  // Орон нутаг: дэлгэрэнгүй хаяг заавал биш — бичээгүй бол зөвхөн аймгийн нэр («Увс»); аймгийн төвийг таамаглаж нэмэхгүй (эзний шийдвэр #125)
  return { province, district, khoroo, addressDetail };
}

export function cleanDeliveryDate(v: unknown): string {
  const today = ubDay();
  const s = v === undefined || v === null || v === '' ? ubDay(new Date(), 1) : String(v);
  if (!isYmd(s)) throw badRequest('Хүргэх өдөр буруу', 'bad_date');
  if (s < today) throw badRequest('Хүргэх өдөр өнгөрсөн өдөр байж болохгүй', 'bad_date');
  if (s > ubDay(new Date(), 120)) throw badRequest('Хүргэх өдөр 120 хоногоос хол байж болохгүй', 'bad_date');
  return s;
}

export function requireReason(v: unknown, code = 'reason_required'): string {
  const p = reasonProblem(v);
  if (p) throw badRequest(p, code);
  return String(v).trim().slice(0, 300);
}

// ───────────────────────── түгжээ (#48) ─────────────────────────
// Нэг дараалал: захиалга (FOR UPDATE) → утас (advisory 1) → бараа (advisory 2, өсөх дарааллаар).

export async function lockPhones(tx: Tx, phones: string[]) {
  for (const p of [...new Set(phones)].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(1::int4, hashtext(${p})::int4)`;
}
export async function lockVariants(tx: Tx, ids: number[]) {
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) await tx.$executeRaw`SELECT pg_advisory_xact_lock(2::int4, ${id}::int4)`;
}
export async function lockOrder(tx: Tx, id: number) {
  const r = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
  return r.length > 0;
}

/** Захиалах боломжтой = агуулахуудын нийт − бусад нөөцлөлт (#39). excludeOrderId — тухайн захиалгын өөрийн нөөцийг тооцохгүй */
export async function availableFor(tx: Tx | typeof db, variantIds: number[], excludeOrderId?: number): Promise<Map<number, number>> {
  if (!variantIds.length) return new Map();
  const ex = excludeOrderId ?? -1;
  const rows = await tx.$queryRaw<{ variantId: number; available: number }[]>`
    SELECT v.id AS "variantId",
      (COALESCE((SELECT sum(b.qty) FROM "StockBalance" b JOIN "StockLocation" l ON l.id = b."locationId" AND l.kind = 'WAREHOUSE' WHERE b."variantId" = v.id), 0)
       - COALESCE((SELECT sum(r.qty) FROM "StockReservation" r WHERE r."variantId" = v.id AND (r."orderId" IS NULL OR r."orderId" <> ${ex})), 0))::int AS available
    FROM "ProductVariant" v WHERE v.id IN (${Prisma.join(variantIds)})`;
  return new Map(rows.map((r) => [r.variantId, r.available]));
}

/** Давхар захиалга (#51): 2 утасны аль нь ч, хүргэлтэд гараагүй идэвхтэй захиалга */
export async function findActiveDuplicate(tx: Tx | typeof db, phones: string[], excludeId?: number) {
  const ph = [...new Set(phones.filter(Boolean))];
  if (!ph.length) return null;
  // Аудит Б3 (хуучин шиг): маргаашаас цааш товлосон («Он сар өдөртэй») захиалга шинэ захиалгыг ХААХГҮЙ — зөвхөн анхааруулна
  return tx.order.findFirst({
    where: { status: { in: ACTIVE }, id: excludeId ? { not: excludeId } : undefined, OR: [{ phone: { in: ph } }, { extraPhone: { in: ph } }],
      NOT: { status: 'NEW', deliveryDate: { gt: dateOnly(ubDay(new Date(), 1)) } } },
    select: { id: true, number: true, status: true, deliveryDate: true, operatorName: true, phone: true, total: true },
    orderBy: { id: 'desc' },
  });
}

export async function activeBlacklist(tx: Tx | typeof db, phones: string[]) {
  const ph = [...new Set(phones.filter(Boolean))];
  if (!ph.length) return [];
  return tx.blacklistEntry.findMany({ where: { phone: { in: ph }, isActive: true }, orderBy: { id: 'desc' }, take: 10 });
}

export async function nextOrderNumber(tx: Tx): Promise<string> {
  const r = await tx.$queryRaw<{ n: string }[]>`SELECT lpad(nextval('order_number_seq')::text, 8, '0') AS n`;
  return r[0]!.n;
}

export function uniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn, { timeout: 20_000, maxWait: 10_000 });
    } catch (e) {
      const code = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : '';
      if (attempt < 2 && (code === 'P2034' || /deadlock detected/i.test(String((e as Error)?.message)))) continue;
      throw e;
    }
  }
}

export const staleError = () => conflict('Энэ захиалгыг өөр хүн дөнгөж сая өөрчилсөн байна. Дахин ачаалаад өөрчлөлтөө хийнэ үү.', 'stale');

/** Пэйж сонгоогүй захиалга энэ системийн пэйжээр хадгалагдана (тайланд тусдаа мөр). Сонгох жагсаалт, тохиргоонд харагдахгүй. */
export const NO_PAGE_NAME = 'Пэйж сонгоогүй';
export async function noPageId(tx: Tx | typeof db): Promise<number> {
  const p = await tx.page.upsert({ where: { name: NO_PAGE_NAME }, create: { name: NO_PAGE_NAME, sortOrder: 9999 }, update: {} });
  return p.id;
}

/**
 * Мөнгө орсон «Төлбөр хүлээж буй» захиалга (#102, хуучин ERP-ийн логик, цуцалж дахин үүсгэхгүй):
 * хуучинд өмнөх өдөр үүссэн бол цуцлаад МӨНГӨ ОРСОН өдөр шинэ захиалга үүсгэж, хуваарилах өдрийг тэр өдөр болгодог байв.
 * Одоо: ижил захиалга (дугаар хэвээр) «Шинэ»; баталгаажсан мөч = одоо (захиалгын «өдөр» болно);
 * хүргэх өдөр мөнгө орсон өдрөөс өмнө бол мөнгө орсон өдөр (хойших — он сар өдөртэй — хэвээр).
 */
export function paidOrderData(o: { deliveryDate: Date }, now = new Date()) {
  const today = ubDay(now);
  const from = o.deliveryDate.toISOString().slice(0, 10);
  const moved = from < today;
  return {
    data: { status: 'NEW' as const, prepaid: true, confirmedAt: now, paymentDeadline: null, ...(moved ? { deliveryDate: new Date(`${today}T00:00:00Z`) } : {}), version: { increment: 1 } },
    deliveryChange: moved ? { from, to: today } : null,
  };
}
