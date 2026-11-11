import type { CancelReason, Order, OrderLine, Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit, SYSTEM_ACTOR } from '../../audit';
import { canEditOrders, canMarkPaid, canSuperviseOperators } from '../../permissions';
import { isUB } from '../../geo';
import { dateOnly, ymdOf } from '../../ubdate';
import { variantLabel } from '../../catalog/variants';
import { cleanIdemKey } from '../stock/core';
import {
  ACTIVE, activeBlacklist, availableFor, cleanAddress, cleanDeliveryDate, cleanOptPhone, cleanPhone, findActiveDuplicate, inTx,
  lockOrder, lockPhones, lockVariants, nextOrderNumber, orderSettings, paidOrderData, requireReason, staleError, uniqueViolation, type Tx, type UserActor, NO_PAGE_NAME, noPageId,
} from './core';
import { enqueueMeta, skipMeta } from './meta';
import { addToHandover, isGiven, lockDelivery, removeFromHandover } from '../delivery/core';

/**
 * Захиалга (Модуль 3, шийдвэр #43–#54).
 * - Дүн, хөнгөлөлт, хүргэлтийн төлбөрийг СЕРВЕР тооцно (хуучинд браузерын дүнд итгэдэг байсан).
 * - Нөөц: захиалах боломжтой = агуулахуудын нийт − нөөцлөлт; хүрэхгүй бол захиалга үүсэхгүй. Бараа хөдлөхгүй (зөвхөн падаанаар).
 * - Давхар дарах / сүлжээ тасрах: idemKey (нэг түлхүүр = нэг захиалга).
 * - Түгжээ: захиалга → утас → бараа (#48).
 */

const MAX_LINES = 50;
const MAX_QTY = 1000;

interface LineInput { variantId?: unknown; qty?: unknown; unitPrice?: unknown; discountReason?: unknown }
interface CleanLine { variantId: number; qty: number; unitPrice: number | null; discountReason: string | null }

function cleanLineInputs(input: unknown): CleanLine[] {
  if (!Array.isArray(input) || !input.length) throw badRequest('Дор хаяж нэг бараа нэмнэ үү', 'no_lines');
  if (input.length > MAX_LINES) throw badRequest(`Нэг захиалгад ${MAX_LINES} хүртэл бараа`);
  const map = new Map<number, CleanLine>();
  for (const raw of input as LineInput[]) {
    const variantId = Number(raw?.variantId);
    if (!Number.isInteger(variantId) || variantId <= 0) throw badRequest('Бараа буруу', 'bad_line');
    const qty = Number(raw?.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw badRequest('Тоо 1-ээс их бүхэл тоо байна', 'bad_qty');
    const up = raw?.unitPrice === undefined || raw?.unitPrice === null || raw?.unitPrice === '' ? null : Number(raw.unitPrice);
    if (up !== null && (!Number.isInteger(up) || up <= 0)) throw badRequest('Үнэ 0-ээс их бүхэл тоо (төгрөг)', 'bad_price');
    const dr = typeof raw?.discountReason === 'string' && raw.discountReason.trim() ? raw.discountReason.trim().slice(0, 300) : null;
    const prev = map.get(variantId);
    map.set(variantId, prev ? { ...prev, qty: prev.qty + qty } : { variantId, qty, unitPrice: up, discountReason: dr });
  }
  return [...map.values()];
}

type Snap = { variantId: number; productId: number; code: string; name: string; label: string; imageKey: string | null; listPrice: number; deliveryIncluded: boolean };

/** Одоогийн барааны мэдээлэл (хуулбар) */
async function snapshots(tx: Tx, ids: number[]): Promise<Map<number, Snap>> {
  const rows = await tx.productVariant.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, code: true, color: true, size: true, isActive: true, priceOverride: true,
      product: { select: { id: true, name: true, price: true, status: true, deliveryIncluded: true, images: { orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }], select: { fileKey: true, color: true } } } },
    },
  });
  const m = new Map<number, Snap>();
  for (const v of rows) {
    if (!v.isActive || v.product.status === 'ARCHIVED') throw badRequest(`«${v.product.name}${v.color || v.size ? ` · ${variantLabel(v)}` : ''}» зарагдахгүй (идэвхгүй / архив)`, 'variant_inactive');
    const img = v.product.images.find((i) => v.color && i.color === v.color) ?? v.product.images[0];
    m.set(v.id, {
      variantId: v.id, productId: v.product.id, code: v.code, name: v.product.name, label: v.color || v.size ? variantLabel(v) : '',
      imageKey: img?.fileKey ?? null, listPrice: v.priceOverride ?? v.product.price, deliveryIncluded: v.product.deliveryIncluded,
    });
  }
  for (const id of ids) if (!m.has(id)) throw badRequest('Бараа олдсонгүй', 'variant_not_found');
  return m;
}

interface PricedLine extends Snap { qty: number; unitPrice: number; discountReason: string | null }

/** Үнэ шалгах (#43 2): зөвхөн бууруулна, шалтгаан заавал. existing — засварт хөндөгдөөгүй мөрийн хуулбар (хуучин үнэ хэвээр) */
function priceLines(input: CleanLine[], snaps: Map<number, Snap>, existing?: Map<number, OrderLine>): PricedLine[] {
  return input.map((l) => {
    const old = existing?.get(l.variantId);
    const base: Snap = old
      ? { variantId: old.variantId, productId: old.productId, code: old.code, name: old.name, label: old.label, imageKey: old.imageKey, listPrice: old.listPrice, deliveryIncluded: old.deliveryIncluded }
      : snaps.get(l.variantId)!;
    const unitPrice = l.unitPrice ?? old?.unitPrice ?? base.listPrice;
    if (unitPrice > base.listPrice) throw badRequest(`«${base.name}» үнийг нэмэх боломжгүй (жагсаалтын үнэ ${base.listPrice}₮)`, 'price_increase');
    let discountReason: string | null = null;
    if (unitPrice < base.listPrice) {
      discountReason = l.discountReason ?? (old && old.unitPrice === unitPrice ? old.discountReason : null);
      if (!discountReason || discountReason.replace(/\s/g, '').length < 5) throw badRequest(`«${base.name}» үнийг бууруулсан шалтгаанаа бичнэ үү (5+ тэмдэгт)`, 'discount_reason');
    }
    return { ...base, qty: l.qty, unitPrice, discountReason };
  });
}

function totals(lines: PricedLine[], province: string, s: { feeUB: number; feeRural: number }, feeInput: { fee?: unknown; reason?: unknown }, current?: { deliveryFee: number; deliveryFeeEdited: boolean }) {
  const subtotal = lines.reduce((a, l) => a + l.listPrice * l.qty, 0);
  const discount = lines.reduce((a, l) => a + (l.listPrice - l.unitPrice) * l.qty, 0);
  const defaultFee = lines.some((l) => !l.deliveryIncluded) ? (isUB(province) ? s.feeUB : s.feeRural) : 0;
  let deliveryFee = defaultFee;
  let deliveryFeeEdited = false;
  let feeReason: string | null = null;
  if (feeInput.fee !== undefined && feeInput.fee !== null && feeInput.fee !== '') {
    const f = Number(feeInput.fee);
    if (!Number.isInteger(f) || f < 0 || f > 1_000_000) throw badRequest('Хүргэлтийн төлбөр буруу', 'bad_fee');
    if (f !== defaultFee) {
      // Хэвээр үлдээсэн засвар бол дахин шалтгаан асуухгүй
      if (!(current?.deliveryFeeEdited && current.deliveryFee === f)) feeReason = requireReason(feeInput.reason, 'fee_reason');
      deliveryFeeEdited = true;
    }
    deliveryFee = f;
  }
  return { subtotal, discount, deliveryFee, deliveryFeeEdited, feeReason, defaultFee, total: subtotal - discount + deliveryFee };
}

async function assertStock(tx: Tx, lines: { variantId: number; qty: number; name: string; label: string }[], excludeOrderId?: number, previous?: Map<number, number>) {
  const need = lines.filter((l) => l.qty > (previous?.get(l.variantId) ?? 0));
  if (!need.length) return;
  const av = await availableFor(tx, need.map((l) => l.variantId), excludeOrderId);
  const short = need.filter((l) => (av.get(l.variantId) ?? 0) < l.qty);
  if (short.length) {
    throw conflict(short.map((l) => `«${l.name}${l.label ? ` · ${l.label}` : ''}»: захиалах боломжтой ${Math.max(0, av.get(l.variantId) ?? 0)}, хэрэгтэй ${l.qty}`).join('; '), 'insufficient_stock');
  }
}

async function replaceReservations(tx: Tx, orderId: number, lines: { variantId: number; qty: number }[]) {
  await tx.stockReservation.deleteMany({ where: { orderId } });
  if (lines.length) await tx.stockReservation.createMany({ data: lines.map((l) => ({ ref: `order:${orderId}`, orderId, variantId: l.variantId, qty: l.qty })) });
}

async function assertPage(tx: Tx | typeof db, actor: UserActor, pageId: number) {
  const p = await tx.page.findUnique({ where: { id: pageId } });
  if (!p || !p.isActive) throw badRequest('Пэйжээ сонгоно уу', 'bad_page');
  if (p.name === NO_PAGE_NAME) return p;
  if (!canSuperviseOperators(actor.roles)) {
    const a = await tx.pageAssignment.findUnique({ where: { userId: actor.id } });
    if (a && a.pageIds.length && !a.pageIds.includes(pageId)) throw forbidden('Энэ пэйж танд хуваарилагдаагүй');
  }
  return p;
}

export interface CreateInput {
  phone?: unknown; extraPhone?: unknown; province?: unknown; district?: unknown; khoroo?: unknown; addressDetail?: unknown;
  note?: unknown; pageId?: unknown; deliveryDate?: unknown; prepaidWait?: unknown; lines?: unknown;
  deliveryFee?: unknown; feeReason?: unknown; blacklistNote?: unknown; idemKey?: unknown;
}

function auditTags(lines: PricedLine[], feeEdited: boolean): string[] {
  const t = ['order'];
  if (lines.some((l) => l.unitPrice < l.listPrice) || feeEdited) t.push('discount');
  return t;
}

export async function createOrder(actor: UserActor, input: CreateInput) {
  if (!canEditOrders(actor.roles)) throw forbidden('Захиалга үүсгэх эрхгүй');
  const idemKey = cleanIdemKey(input.idemKey);
  const existing = await db.order.findUnique({ where: { idemKey } });
  if (existing) return { order: existing, duplicate: true };

  const phone = cleanPhone(input.phone);
  const extraPhone = cleanOptPhone(input.extraPhone);
  if (extraPhone === phone) throw badRequest('Нэмэлт утас үндсэн утастай ижил байна', 'bad_phone');
  const addr = cleanAddress(input);
  // Пэйж сонгоогүй бол «Пэйж сонгоогүй» нэрээр хадгална (эзний шийдвэр #58)
  const pageInput = input.pageId === undefined || input.pageId === null || input.pageId === '' ? 0 : Number(input.pageId);
  if (!Number.isInteger(pageInput) || pageInput < 0) throw badRequest('Пэйж буруу', 'bad_page');
  const noPage = pageInput === 0;
  const pageId = noPage ? await noPageId(db) : pageInput;
  const deliveryDate = cleanDeliveryDate(input.deliveryDate);
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const lineIn = cleanLineInputs(input.lines);
  const settings = await orderSettings();
  // Орон нутаг заавал урьдчилгаатай (#43 8); УБ «Урьдчилгаа хүлээх» тэмдэглэвэл (#51)
  const pending = !isUB(addr.province) || input.prepaidWait === true;

  try {
    let replay: Order | null = null;
    const order = await inTx(async (tx) => {
      await assertPage(tx, actor, pageId);
      const phones = [phone, ...(extraPhone ? [extraPhone] : [])];
      await lockPhones(tx, phones);
      // Ижил түлхүүрээр зэрэг ирсэн хүсэлт түгжээ хүлээж байсан бол — эхнийх нь үүсгэсэн захиалгыг буцаана (давхардал биш)
      replay = await tx.order.findUnique({ where: { idemKey } });
      if (replay) return replay;
      const dup = await findActiveDuplicate(tx, phones);
      if (dup) throw conflict(`Энэ утсаар идэвхтэй захиалга №${dup.number} байна — тэр захиалгад бараа нэмнэ үү`, 'duplicate_order');
      const bl = await activeBlacklist(tx, phones);
      let blacklistNote: string | null = null;
      if (bl.length) blacklistNote = requireReason(input.blacklistNote, 'blacklist_confirm');
      const snaps = await snapshots(tx, lineIn.map((l) => l.variantId));
      const lines = priceLines(lineIn, snaps);
      const t = totals(lines, addr.province, settings, { fee: input.deliveryFee, reason: input.feeReason });
      await lockVariants(tx, lines.map((l) => l.variantId));
      await assertStock(tx, lines);
      const now = new Date();
      const o = await tx.order.create({
        data: {
          number: await nextOrderNumber(tx), status: pending ? 'PENDING_PAYMENT' : 'NEW', phone, extraPhone, ...addr, note, pageId,
          operatorId: actor.id, operatorName: actor.name, deliveryDate: dateOnly(deliveryDate),
          confirmedAt: pending ? null : now, paymentDeadline: pending ? new Date(now.getTime() + settings.waitDays * 86_400_000) : null,
          subtotal: t.subtotal, discount: t.discount, deliveryFee: t.deliveryFee, total: t.total, deliveryFeeEdited: t.deliveryFeeEdited,
          blacklistNote, idemKey,
          lines: { create: lines.map(({ variantId, productId, code, name, label, imageKey, listPrice, unitPrice, qty, discountReason, deliveryIncluded }) => ({ variantId, productId, code, name, label, imageKey, listPrice, unitPrice, qty, discountReason, deliveryIncluded })) },
        },
      });
      await replaceReservations(tx, o.id, lines);
      if (!pending) await enqueueMeta(tx, o.id);
      // Дуудлагын бүртгэлийг автоматаар холбоно (хуучин логик)
      await tx.callNote.updateMany({ where: { phone: { in: phones }, status: { in: ['PENDING', 'CONTACTED'] } }, data: { status: 'ORDERED', orderId: o.id, closedAt: now } });
      if (!noPage) await tx.user.update({ where: { id: actor.id }, data: { lastPageId: pageId } });
      await writeAudit(actor, 'order.created', 'Order', String(o.id), {
        number: o.number, status: o.status, phone, total: o.total, discount: t.discount, deliveryFee: t.deliveryFee,
        lines: lines.map((l) => ({ code: l.code, qty: l.qty, unitPrice: l.unitPrice, listPrice: l.listPrice, discountReason: l.discountReason })),
        ...(t.feeReason ? { feeReason: t.feeReason, defaultFee: t.defaultFee } : {}), ...(blacklistNote ? { blacklistNote } : {}),
      } as Prisma.InputJsonValue, tx, auditTags(lines, t.deliveryFeeEdited));
      return o;
    });
    // Модуль 6: тухайн утасны таараагүй банкны гүйлгээ байвал «Мөнгө орсон» (хуучин шиг)
    if (!replay && order.status === 'PENDING_PAYMENT') await bankRematch(order.id);
    return { order, duplicate: replay !== null };
  } catch (e) {
    if (uniqueViolation(e)) { const r = await db.order.findUnique({ where: { idemKey } }); if (r) return { order: r, duplicate: true }; }
    throw e;
  }
}

export interface UpdateInput extends Omit<CreateInput, 'idemKey' | 'prepaidWait'> { version?: unknown }

/** Засвар: бараа нэмэх/хасах/тоо/үнэ — нөөцийг зөрүүгээр, бүгд эсвэл юу ч үгүй (#43, #48) */
export async function updateOrder(actor: UserActor, idInput: unknown, input: UpdateInput) {
  if (!canEditOrders(actor.roles)) throw forbidden('Захиалга засах эрхгүй');
  const id = Number(idInput);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Захиалга олдсонгүй');
  const version = Number(input.version);
  if (!Number.isInteger(version)) throw badRequest('Хувилбарын дугаар алга', 'version_required');
  const settings = await orderSettings();

  const res = await inTx(async (tx) => {
    // Жолоочид оноосон захиалгын огноо өөрчлөгдвөл падаантай уялдана — хүргэлтийн түгжээг эхэлж авна
    const pre = await tx.order.findUnique({ where: { id }, select: { status: true } });
    if (pre?.status === 'ASSIGNED') await lockDelivery(tx);
    if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
    const o = await tx.order.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    if (o.version !== version) throw staleError();
    if (!ACTIVE.includes(o.status)) throw conflict('Хүргэлтэд гарсан / дууссан / цуцлагдсан захиалгыг засахгүй', 'order_locked');
    const linesChanging = input.lines !== undefined;
    // Хуучин ERP шиг: падаан үүссэн захиалгыг огт засахгүй (#66)
    if (o.handoverId) throw conflict('Падаан үүссэн захиалгыг засах боломжгүй', 'in_handover');

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const data: Prisma.OrderUpdateInput = {};
    const phone = input.phone !== undefined ? cleanPhone(input.phone) : o.phone;
    const extraPhone = input.extraPhone !== undefined ? cleanOptPhone(input.extraPhone) : o.extraPhone;
    if (extraPhone && extraPhone === phone) throw badRequest('Нэмэлт утас үндсэн утастай ижил байна', 'bad_phone');
    if (phone !== o.phone) { data.phone = phone; changes.phone = { from: o.phone, to: phone }; }
    if (extraPhone !== o.extraPhone) { data.extraPhone = extraPhone; changes.extraPhone = { from: o.extraPhone, to: extraPhone }; }
    if (phone !== o.phone || extraPhone !== o.extraPhone) {
      const phones = [phone, ...(extraPhone ? [extraPhone] : [])];
      await lockPhones(tx, phones);
      const dup = await findActiveDuplicate(tx, phones, id);
      if (dup) throw conflict(`Энэ утсаар идэвхтэй захиалга №${dup.number} байна`, 'duplicate_order');
      const bl = await activeBlacklist(tx, phones);
      if (bl.length && !o.blacklistNote) data.blacklistNote = requireReason(input.blacklistNote, 'blacklist_confirm');
    }
    let province = o.province;
    if (input.province !== undefined || input.district !== undefined || input.khoroo !== undefined || input.addressDetail !== undefined) {
      const a = cleanAddress({
        province: input.province ?? o.province, district: input.district !== undefined ? input.district : o.district,
        khoroo: input.khoroo !== undefined ? input.khoroo : o.khoroo, addressDetail: input.addressDetail ?? o.addressDetail,
      });
      province = a.province;
      for (const k of ['province', 'district', 'khoroo', 'addressDetail'] as const) {
        if (a[k] !== o[k]) { (data as Record<string, unknown>)[k] = a[k]; changes[k] = { from: o[k], to: a[k] }; }
      }
    }
    if (input.note !== undefined) { const n = String(input.note ?? '').trim().slice(0, 500) || null; if (n !== o.note) { data.note = n; changes.note = { from: o.note, to: n }; } }
    if (input.pageId !== undefined) {
      const pid = input.pageId === null || input.pageId === '' || Number(input.pageId) === 0 ? await noPageId(tx) : Number(input.pageId);
      if (pid !== o.pageId) { await assertPage(tx, actor, pid); data.pageId = pid; changes.pageId = { from: o.pageId, to: pid }; }
    }
    if (input.deliveryDate !== undefined) {
      const d = cleanDeliveryDate(input.deliveryDate);
      if (d !== ymdOf(o.deliveryDate)) {
        // Тэр өдрийн падаан өгөгдсөн бол оруулахгүй (ахлах жолооч өөр өдөр/жолооч сонгоно)
        if (o.status === 'ASSIGNED' && o.driverId) {
          const h = await tx.handover.findUnique({ where: { driverId_date: { driverId: o.driverId, date: dateOnly(d) } }, select: { status: true } });
          if (h && isGiven(h.status)) throw conflict(`${o.driverName}-ийн ${d}-ны падаан аль хэдийн өгөгдсөн — өөр өдөр сонгоно уу`, 'handed_over');
        }
        data.deliveryDate = dateOnly(d); changes.deliveryDate = { from: ymdOf(o.deliveryDate), to: d };
      }
    }

    // Бараа ба дүн
    const existing = new Map(o.lines.map((l) => [l.variantId, l]));
    const lineIn = linesChanging ? cleanLineInputs(input.lines)
      : o.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, discountReason: l.discountReason }));
    const newIds = lineIn.filter((l) => !existing.has(l.variantId)).map((l) => l.variantId);
    const snaps = newIds.length ? await snapshots(tx, newIds) : new Map<number, Snap>();
    const lines = priceLines(lineIn, snaps, existing);
    const feeInput = input.deliveryFee !== undefined ? { fee: input.deliveryFee, reason: input.feeReason }
      : o.deliveryFeeEdited ? { fee: o.deliveryFee } : {};
    const t = totals(lines, province, settings, feeInput, o);
    if (linesChanging) {
      await lockVariants(tx, [...new Set([...lines.map((l) => l.variantId), ...o.lines.map((l) => l.variantId)])]);
      await assertStock(tx, lines, id, new Map(o.lines.map((l) => [l.variantId, l.qty])));
      const diff: string[] = [];
      for (const l of lines) {
        const old = existing.get(l.variantId);
        if (!old) diff.push(`+ ${l.name}${l.label ? ` · ${l.label}` : ''} ${l.qty}ш`);
        else if (old.qty !== l.qty || old.unitPrice !== l.unitPrice) diff.push(`${l.name}${l.label ? ` · ${l.label}` : ''}: ${old.qty}ш → ${l.qty}ш${old.unitPrice !== l.unitPrice ? `, ${old.unitPrice}₮ → ${l.unitPrice}₮` : ''}`);
      }
      for (const old of o.lines) if (!lines.some((l) => l.variantId === old.variantId)) diff.push(`− ${old.name}${old.label ? ` · ${old.label}` : ''} ${old.qty}ш`);
      if (diff.length) {
        changes.lines = { from: null, to: diff };
        await tx.orderLine.deleteMany({ where: { orderId: id } });
        await tx.orderLine.createMany({ data: lines.map(({ variantId, productId, code, name, label, imageKey, listPrice, unitPrice, qty, discountReason, deliveryIncluded }) => ({ orderId: id, variantId, productId, code, name, label, imageKey, listPrice, unitPrice, qty, discountReason, deliveryIncluded })) });
        await replaceReservations(tx, id, lines);
      }
    }
    if (t.total !== o.total || t.deliveryFee !== o.deliveryFee || t.discount !== o.discount) {
      Object.assign(data, { subtotal: t.subtotal, discount: t.discount, deliveryFee: t.deliveryFee, total: t.total, deliveryFeeEdited: t.deliveryFeeEdited });
      changes.total = { from: o.total, to: t.total };
      if (t.deliveryFee !== o.deliveryFee) changes.deliveryFee = { from: o.deliveryFee, to: t.deliveryFee };
    }
    if (!Object.keys(changes).length) return { order: o, changed: false };
    const u = await tx.order.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
    if (changes.deliveryDate && o.status === 'ASSIGNED' && o.driverId) {
      const h = await tx.handover.findUnique({ where: { driverId_date: { driverId: o.driverId, date: u.deliveryDate } }, select: { id: true, status: true } });
      if (h && !isGiven(h.status)) await addToHandover(tx, h.id, id);
    }
    const discountNow = lines.some((l) => l.unitPrice < l.listPrice && existing.get(l.variantId)?.unitPrice !== l.unitPrice) || !!t.feeReason;
    await writeAudit(actor, 'order.updated', 'Order', String(id), { number: o.number, changes, ...(t.feeReason ? { feeReason: t.feeReason } : {}) } as unknown as Prisma.InputJsonValue, tx,
      discountNow ? ['order', 'discount'] : ['order']);
    return { order: u, changed: true };
  });
  if (res.changed && res.order.status === 'PENDING_PAYMENT') await bankRematch(res.order.id);
  return res;
}

const CANCEL_REASONS: CancelReason[] = ['CUSTOMER_CANCELLED', 'DUPLICATE', 'OUT_OF_STOCK', 'NO_ANSWER', 'OTHER'];

/** Цуцлах (#43 11): шалтгаан сонгоно + тайлбар. Нөөц суллагдана. Хүргэлтэд гарсан бол жолоочийн модульд (Модуль 5). */
export async function cancelOrder(actor: UserActor | typeof SYSTEM_ACTOR & { roles?: never }, idInput: unknown, input: { reason?: unknown; note?: unknown; version?: unknown }, opts: { system?: boolean } = {}) {
  if (!opts.system && !canEditOrders((actor as UserActor).roles)) throw forbidden('Захиалга цуцлах эрхгүй');
  const id = Number(idInput);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Захиалга олдсонгүй');
  const reason = (opts.system ? 'PAYMENT_TIMEOUT' : String(input.reason ?? '')) as CancelReason;
  if (!opts.system && !CANCEL_REASONS.includes(reason)) throw badRequest('Цуцлах шалтгаанаа сонгоно уу', 'cancel_reason');
  const note = opts.system ? 'Төлбөрийн хугацаа дууссан (автомат)' : requireReason(input.note, 'reason_required');
  return inTx(async (tx) => {
    // Модуль 4: хуваарилсан/падаанд орсон захиалгыг цуцлахад падааны түгжээг эхэлж авна (deadlock-гүй дараалал)
    const pre = await tx.order.findUnique({ where: { id }, select: { status: true } });
    if (pre && (pre.status === 'NEW' || pre.status === 'ASSIGNED')) await lockDelivery(tx);
    if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
    const o = await tx.order.findUniqueOrThrow({ where: { id } });
    if (o.status === 'CANCELLED') return { order: o, duplicate: true };
    // Автомат цуцлалт: түгжсэний дараа дахин шалгана (энэ хооронд «Мөнгө орсон» болсон байж болно)
    if (opts.system && !(o.status === 'PENDING_PAYMENT' && o.paymentDeadline && o.paymentDeadline < new Date())) return { order: o, duplicate: true };
    if (!ACTIVE.includes(o.status)) throw conflict('Хүргэлтэд гарсан захиалгыг жолооч цуцална (бараа нь жолоочид байгаа)', 'order_locked');
    if (input.version !== undefined && Number(input.version) !== o.version) throw staleError();
    const u = await tx.order.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason, cancelNote: note, cancelledAt: new Date(), cancelledByName: actor.name, version: { increment: 1 } } });
    await tx.stockReservation.deleteMany({ where: { orderId: id } });
    // Падаанд (өгөхөөс өмнө) байсан бол хасагдана — агуулахад улаанаар «тавиурт буцаа» гэж харагдана
    if (o.handoverId) await removeFromHandover(tx, id, 'Цуцлагдсан');
    await skipMeta(tx, id);
    await writeAudit(actor, 'order.cancelled', 'Order', String(id), { number: o.number, from: o.status, reason, note }, tx, ['order', 'cancel']);
    return { order: u, duplicate: false };
  });
}

/** «Мөнгө орсон» (#43 9): Төлбөр хүлээж буй → Шинэ; баталгаажсан өдөр = одоо (үүссэн огноо хэвээр); Meta илгээнэ */
export async function markPaid(actor: UserActor, idInput: unknown) {
  if (!canMarkPaid(actor.roles)) throw forbidden('«Мөнгө орсон»-ыг ахлах оператор, админ тэмдэглэнэ');
  const id = Number(idInput);
  return inTx(async (tx) => {
    if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
    const o = await tx.order.findUniqueOrThrow({ where: { id } });
    if (o.prepaid && o.status !== 'PENDING_PAYMENT') return { order: o, duplicate: true };
    if (o.status !== 'PENDING_PAYMENT') throw conflict('Зөвхөн «Төлбөр хүлээж буй» захиалгад', 'bad_status');
    const pd = paidOrderData(o);
    const u = await tx.order.update({ where: { id }, data: pd.data });
    await enqueueMeta(tx, id);
    await writeAudit(actor, 'order.paid', 'Order', String(id), { number: o.number, total: o.total, ...(pd.deliveryChange ? { deliveryDate: pd.deliveryChange } : {}) }, tx, ['order', 'money']);
    return { order: u, duplicate: false };
  });
}

/** Алдаатай «Мөнгө орсон»-ыг буцаах — жолоочид оноогоогүй үед */
export async function undoPaid(actor: UserActor, idInput: unknown, input: { note?: unknown }) {
  if (!canMarkPaid(actor.roles)) throw forbidden();
  const id = Number(idInput);
  const note = requireReason(input.note);
  const { waitDays } = await orderSettings();
  return inTx(async (tx) => {
    if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
    const o = await tx.order.findUniqueOrThrow({ where: { id } });
    if (!(o.status === 'NEW' && o.prepaid)) throw conflict('Зөвхөн «Мөнгө орсон» гэж тэмдэглэсэн, оноогоогүй захиалгыг буцаана', 'bad_status');
    const u = await tx.order.update({ where: { id }, data: { status: 'PENDING_PAYMENT', prepaid: false, confirmedAt: null, paymentDeadline: new Date(Date.now() + waitDays * 86_400_000), version: { increment: 1 } } });
    await skipMeta(tx, id);
    await writeAudit(actor, 'order.paid_undone', 'Order', String(id), { number: o.number, note }, tx, ['order', 'money']);
    return { order: u };
  });
}

/** Төлбөрийн хугацаа сунгах (#43 8) — ахлах оператор */
export async function extendDeadline(actor: UserActor, idInput: unknown, input: { days?: unknown }) {
  if (!canMarkPaid(actor.roles)) throw forbidden();
  const id = Number(idInput);
  const days = Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw badRequest('Хоног 1–60');
  return inTx(async (tx) => {
    if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
    const o = await tx.order.findUniqueOrThrow({ where: { id } });
    if (o.status !== 'PENDING_PAYMENT') throw conflict('Зөвхөн «Төлбөр хүлээж буй» захиалгад', 'bad_status');
    const base = Math.max(Date.now(), o.paymentDeadline?.getTime() ?? 0);
    const u = await tx.order.update({ where: { id }, data: { paymentDeadline: new Date(base + days * 86_400_000), version: { increment: 1 } } });
    await writeAudit(actor, 'order.deadline_extended', 'Order', String(id), { number: o.number, days, until: u.paymentDeadline }, tx, ['order']);
    return { order: u };
  });
}

/** Хугацаа нь дууссан «Төлбөр хүлээж буй» захиалгыг автоматаар цуцална (арын ажил) */
export async function autoCancelExpired(limit = 200): Promise<number> {
  const due = await db.order.findMany({ where: { status: 'PENDING_PAYMENT', paymentDeadline: { lt: new Date() } }, select: { id: true }, take: limit, orderBy: { paymentDeadline: 'asc' } });
  let n = 0;
  for (const o of due) {
    try { const r = await cancelOrder(SYSTEM_ACTOR as never, o.id, {}, { system: true }); if (!r.duplicate) n++; } catch { /* дараагийн удаа */ }
  }
  return n;
}

export type { Order };

/** Банкны гүйлгээгээр дахин тааруулах — алдаа гарсан ч захиалгын үйлдлийг унагахгүй */
async function bankRematch(orderId: number) {
  try {
    const { matchOrderWithTransactions } = await import('../accounting/bank');
    await matchOrderWithTransactions(orderId);
  } catch (e) { console.error('[bank] rematch', (e as Error).message); }
}
