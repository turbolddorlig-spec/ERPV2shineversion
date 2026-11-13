import type { LoanStatus, Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit } from '../../audit';
import { canLoanFinance, canOperateStock, canRequestLoan, canSeeAllLoans, canView } from '../../permissions';
import {
  applyMoves, assertNotReserved, claimIdem, cleanId, cleanIdemKey, cleanLines, cleanNote, getSettingNumber, inTx, lockReservedVariants, requireRole, staffLocationId, uniqueViolation, warehouseLocation, type UserActor,
} from './core';
import { bustTodayCache } from './views';
import { variantInfo } from './info';

/**
 * Ажилтны бараа зээл (#38): хүсэлт → агуулах олгохдоо батална → буцаалт (хэсэгчлэн ч болно).
 * Буцаагаагүй нь цалингаас: нэгжийн суутгал = үнэ − хямдрал (анх 5,000₮; Супер админ / Нягтлан засна).
 * Бодит суутгал Цалингийн модульд; энд «Цалингаас суутгах» гэж тэмдэглэхэд бараа ажилтны гараас хасагдана.
 */
export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = {
  REQUESTED: 'Хүсэлт', ISSUED: 'Олгосон', CLOSED: 'Хаагдсан', REJECTED: 'Татгалзсан', CANCELLED: 'Цуцалсан',
};
export const LOAN_DISCOUNT_KEY = 'loanDiscount';
export const getLoanDiscount = () => getSettingNumber(LOAN_DISCOUNT_KEY, 5000);

const outstanding = (l: { qty: number; returnedQty: number; chargedQty: number }) => l.qty - l.returnedQty - l.chargedQty;

/** Аудит #149 (эзний шийдвэр): 16,000₮-өөс доош үнэтэй бараа хөнгөлөлт (5,000₮) эдлэхгүй — бүтэн үнээр */
export const LOAN_DISCOUNT_MIN_PRICE = 16_000;
export const loanDeduction = (unitPrice: number, discount: number) => (unitPrice < LOAN_DISCOUNT_MIN_PRICE ? unitPrice : Math.max(0, unitPrice - discount));
/** Аудит #149 (эзний шийдвэр): өөрийнхөө зээлийг олгох, буцаах, суутгал засахгүй (Супер админаас бусад) */
const assertNotSelf = (actor: UserActor, staffId: string, what: string) => {
  if (staffId === actor.id && !actor.roles.includes('SUPER_ADMIN')) throw forbidden(`Өөрийнхөө зээлийг ${what} боломжгүй — өөр хүн хийнэ`);
};
/** Зээл авч болох хүн: идэвхтэй, зээлийн эрхтэй (жолооч, нийлүүлэгч биш) */
async function assertBorrower(tx: Prisma.TransactionClient | typeof db, staffId: string) {
  const u = await tx.user.findUnique({ where: { id: staffId }, select: { isActive: true, roles: true } });
  if (!u || !u.isActive) throw conflict('Ажилтан идэвхгүй болсон — зээл олгохгүй', 'inactive_staff');
  if (!canRequestLoan(u.roles) && !u.roles.includes('SUPER_ADMIN')) throw conflict('Энэ ажилтанд бараа зээл олгохгүй (жолооч, нийлүүлэгч)', 'not_borrower');
}
/** Тухайн хүний одоо байгаа (олгосон, буцаагаагүй) зээл — олгохдоо харуулна */
export async function staffLoanSummary(staffId: string) {
  const r = await db.$queryRaw<{ loans: number; pieces: number; amount: bigint }[]>`
    SELECT count(DISTINCT l.id)::int AS loans, COALESCE(sum(x.qty - x."returnedQty" - x."chargedQty"), 0)::int AS pieces,
           COALESCE(sum((x.qty - x."returnedQty" - x."chargedQty") * COALESCE(x.deduction, 0)), 0)::bigint AS amount
    FROM "StaffLoan" l JOIN "StaffLoanLine" x ON x."loanId" = l.id WHERE l."staffId" = ${staffId}::uuid AND l.status = 'ISSUED'`;
  return { loans: r[0]?.loans ?? 0, pieces: r[0]?.pieces ?? 0, amount: Number(r[0]?.amount ?? 0) };
}

export async function requestLoan(actor: UserActor, input: { lines?: unknown; note?: unknown; idemKey?: unknown }) {
  requireRole(canRequestLoan(actor.roles), 'Бараа зээл хүсэх эрхгүй');
  const idemKey = cleanIdemKey(input.idemKey);
  const existing = await db.staffLoan.findUnique({ where: { idemKey } });
  // Аудит А11: өөр хүний ижил түлхүүрээр бусдын зээл буцаахгүй
  if (existing) { if (existing.staffId !== actor.id) throw conflict('Хүсэлтийн түлхүүр давхацлаа — хуудсаа дахин ачаална уу', 'idem_conflict'); return { loan: existing, duplicate: true }; }
  const note = cleanNote(input.note);
  const { lines } = await cleanLines(input.lines);
  // Аудит А11: идэвхгүй (архивласан / хасагдсан) хувилбарыг зээлэхгүй
  const inactive = await db.productVariant.count({ where: { id: { in: lines.map((x) => x.variantId) }, OR: [{ isActive: false }, { product: { status: 'ARCHIVED' } }] } });
  if (inactive) throw badRequest('Идэвхгүй / архивласан бараа зээлэх боломжгүй', 'inactive_variant');
  const pv = await db.productVariant.findMany({ where: { id: { in: lines.map((x) => x.variantId) } }, select: { id: true, priceOverride: true, product: { select: { price: true } } } });
  const reqPrice = new Map(pv.map((v) => [v.id, v.priceOverride ?? v.product.price]));
  try {
    const loan = await db.$transaction(async (tx) => {
      const l = await tx.staffLoan.create({
        data: { staffId: actor.id, staffName: actor.name, note, idemKey, lines: { create: lines.map((x) => ({ variantId: x.variantId, qty: x.qty, requestPrice: reqPrice.get(x.variantId) ?? null })) } },
      });
      bustTodayCache();
      await writeAudit(actor, 'loan.requested', 'StaffLoan', String(l.id), { lines: lines.length, total: lines.reduce((s, x) => s + x.qty, 0), note }, tx, ['stock', 'loan']);
      return l;
    });
    return { loan, duplicate: false };
  } catch (e) {
    if (uniqueViolation(e)) { const r = await db.staffLoan.findUnique({ where: { idemKey } }); if (r) return { loan: r, duplicate: true }; }
    throw e;
  }
}

async function loadLoan(tx: Prisma.TransactionClient | typeof db, id: number) {
  const l = await tx.staffLoan.findUnique({ where: { id }, include: { lines: { orderBy: { variantId: 'asc' } } } });
  if (!l) throw notFound('Зээл олдсонгүй');
  return l;
}

/** Ажилтан өөрийн хүсэлтийг цуцлах (олгохоос өмнө) */
export async function cancelLoan(actor: UserActor, idInput: unknown, input: { note?: unknown } = {}) {
  const id = cleanId(idInput, 'Зээл');
  const l = await loadLoan(db, id);
  if (l.staffId !== actor.id && !canOperateStock(actor.roles)) throw forbidden();
  // Аудит #149: өөр хүний хүсэлтийг цуцлахад шалтгаан заавал
  const note = l.staffId === actor.id ? cleanNote(input.note) : cleanNote(input.note, { required: true });
  if (l.status === 'CANCELLED') return l;
  if (l.status !== 'REQUESTED') throw conflict('Олгосон зээлийг цуцлахгүй — буцаалтаар хаана', 'loan_issued');
  const ok = await db.staffLoan.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: 'CANCELLED', closedAt: new Date(), decidedNote: note } });
  bustTodayCache();
  if (ok.count) await writeAudit(actor, 'loan.cancelled', 'StaffLoan', String(id), { staff: l.staffName, note }, db, ['loan']);
  return loadLoan(db, id);
}

export async function rejectLoan(actor: UserActor, idInput: unknown, input: { note?: unknown }) {
  requireRole(canOperateStock(actor.roles));
  const id = cleanId(idInput, 'Зээл');
  const note = cleanNote(input.note, { required: true });
  const ok = await db.staffLoan.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: 'REJECTED', decidedNote: note, closedAt: new Date() } });
  if (!ok.count) { const l = await loadLoan(db, id); if (l.status === 'REJECTED') return l; throw conflict('Энэ хүсэлт шийдэгдсэн байна'); }
  bustTodayCache();
  await writeAudit(actor, 'loan.rejected', 'StaffLoan', String(id), { note, by: actor.name }, db, ['loan']);
  return loadLoan(db, id);
}

/** Агуулах олгоно (тоог багасгаж болно). Үнэ, суутгал энэ мөчийн байдлаар хадгалагдана. */
export async function issueLoan(actor: UserActor, idInput: unknown, input: { warehouseId?: unknown; lines?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Зээлийг Агуулах олгоно');
  const id = cleanId(idInput, 'Зээл');
  const warehouseId = cleanId(input.warehouseId, 'Агуулах');
  const adjust = new Map<number, number>();
  if (Array.isArray(input.lines)) for (const r of input.lines as { variantId?: unknown; qty?: unknown }[]) {
    const q = Number(r?.qty);
    if (!Number.isInteger(q) || q < 0) throw badRequest('Тоо буруу', 'bad_qty');
    adjust.set(cleanId(r?.variantId, 'Бараа'), q);
  }
  const discount = await getLoanDiscount();
  return inTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "StaffLoan" WHERE id = ${id} FOR UPDATE`;
    const l = await loadLoan(tx, id);
    if (l.status === 'ISSUED') return { loan: l, duplicate: true };
    // Аудит #149: зэрэг цуцлагдсан / татгалзсан бол «олгосон» гэж харуулахгүй
    if (l.status !== 'REQUESTED') throw conflict(`Энэ хүсэлт ${LOAN_STATUS_LABEL[l.status]} болсон байна`, 'loan_decided');
    assertNotSelf(actor, l.staffId, 'өөртөө олгох');
    await assertBorrower(tx, l.staffId);
    await tx.staffLoan.update({ where: { id }, data: { status: 'ISSUED' } });
    const { warehouse, locationId } = await warehouseLocation(tx, warehouseId);
    const staffLoc = await staffLocationId(tx, { id: l.staffId, name: l.staffName });
    // Аудит #149: хувилбарын түгжээ аваад идэвхтэй эсэхийг дахин шалгана (архивлахтай зэрэг ирвэл)
    await lockReservedVariants(tx, l.lines);
    const variants = await tx.productVariant.findMany({ where: { id: { in: l.lines.map((x) => x.variantId) } }, select: { id: true, isActive: true, priceOverride: true, product: { select: { price: true, status: true } } } });
    if (variants.some((v) => !v.isActive || v.product.status === 'ARCHIVED')) throw badRequest('Идэвхгүй / архивласан бараа зээлэх боломжгүй', 'inactive_variant');
    // Аудит #149: хүсэлтийн үеийн ба одоогийн үнийн ИХ нь — үнийг түр бууруулж суутгалыг багасгахгүй
    const nowPrice = new Map(variants.map((v) => [v.id, v.priceOverride ?? v.product.price]));
    const price = new Map(l.lines.map((x) => [x.variantId, Math.max(nowPrice.get(x.variantId) ?? 0, x.requestPrice ?? 0)]));
    const moves = [];
    for (const line of l.lines) {
      const q = adjust.has(line.variantId) ? adjust.get(line.variantId)! : line.qty;
      if (q > line.qty) throw badRequest('Хүссэнээс их олгохгүй', 'bad_qty');
      if (q === 0) { await tx.staffLoanLine.delete({ where: { id: line.id } }); continue; }
      const unitPrice = price.get(line.variantId) ?? 0;
      await tx.staffLoanLine.update({ where: { id: line.id }, data: { qty: q, unitPrice, deduction: loanDeduction(unitPrice, discount) } });
      moves.push({ type: 'LOAN_OUT' as const, variantId: line.variantId, qty: q, fromId: locationId, toId: staffLoc, note: `${l.staffName}-д зээл` });
    }
    if (!moves.length) throw badRequest('Дор хаяж нэг бараа олгоно уу', 'no_lines');
    // Аудит #142 (эзний шийдвэр, Б10 шиг): захиалгад түгжигдсэн барааг ажилтанд зээлээр гаргахгүй
    await applyMoves(tx, actor, { type: 'loan', id }, moves);
    await assertNotReserved(tx, moves, undefined, true);
    const u = await tx.staffLoan.update({ where: { id }, data: { warehouseId, issuedById: actor.id, issuedByName: actor.name, issuedAt: new Date() }, include: { lines: true } });
    const lines = await tx.staffLoanLine.findMany({ where: { loanId: id }, select: { variantId: true, qty: true, unitPrice: true, deduction: true } });
    await writeAudit(actor, 'loan.issued', 'StaffLoan', String(id), { staff: l.staffName, warehouse: warehouse.name, total: moves.reduce((s, m) => s + m.qty, 0), lines } as unknown as Prisma.InputJsonValue, tx, ['stock', 'loan']);
    return { loan: u, duplicate: false };
  });
}

/** Буцаалт хүлээн авах (хэсэгчлэн ч болно). Бүгд буцвал зээл хаагдана. */
export async function returnLoan(actor: UserActor, idInput: unknown, input: { warehouseId?: unknown; lines?: unknown; idemKey?: unknown }) {
  requireRole(canOperateStock(actor.roles), 'Буцаалтыг Агуулах хүлээн авна');
  const id = cleanId(idInput, 'Зээл');
  const idemKey = cleanIdemKey(input.idemKey);
  const warehouseId = cleanId(input.warehouseId, 'Агуулах');
  const { lines } = await cleanLines(input.lines);
  return inTx(async (tx) => {
    if (!(await claimIdem(tx, `loan-return:${idemKey}`))) return { loan: await loadLoan(tx, id), duplicate: true };
    // Нэг зээлийг нэг удаад нэг л хүн буцааж бүртгэнэ (#124-А) — зэрэг буцаахад илүү буцаагдахгүй
    await tx.$queryRaw`SELECT id FROM "StaffLoan" WHERE id = ${id} FOR UPDATE`;
    const l = await loadLoan(tx, id);
    if (l.status !== 'ISSUED') throw conflict('Энэ зээл нээлттэй биш байна', 'loan_not_issued');
    assertNotSelf(actor, l.staffId, 'өөрөө буцааж авах');
    const { warehouse, locationId } = await warehouseLocation(tx, warehouseId);
    const staffLoc = await staffLocationId(tx, { id: l.staffId, name: l.staffName });
    const moves = [];
    for (const r of lines) {
      const line = l.lines.find((x) => x.variantId === r.variantId);
      if (!line) throw badRequest('Энэ бараа зээлд байхгүй');
      if (r.qty > outstanding(line)) throw badRequest(`Буцаах тоо үлдэгдлээс (${outstanding(line)}) их байна`, 'bad_qty');
      await tx.staffLoanLine.update({ where: { id: line.id }, data: { returnedQty: { increment: r.qty } } });
      moves.push({ type: 'LOAN_RETURN' as const, variantId: r.variantId, qty: r.qty, fromId: staffLoc, toId: locationId, note: `${l.staffName}-с буцаалт` });
    }
    await applyMoves(tx, actor, { type: 'loan', id }, moves);
    const after = await loadLoan(tx, id);
    if (after.lines.every((x) => outstanding(x) === 0)) await tx.staffLoan.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
    await writeAudit(actor, 'loan.returned', 'StaffLoan', String(id), { staff: l.staffName, warehouse: warehouse.name, total: moves.reduce((s, m) => s + m.qty, 0) }, tx, ['stock', 'loan']);
    return { loan: await loadLoan(tx, id), duplicate: false };
  });
}

/** Нэгжийн суутгалыг засах (Супер админ / Нягтлан) */
export async function setLoanDeduction(actor: UserActor, idInput: unknown, input: { variantId?: unknown; deduction?: unknown }) {
  requireRole(canLoanFinance(actor.roles), 'Суутгалыг Супер админ, Нягтлан засна');
  const id = cleanId(idInput, 'Зээл');
  const variantId = cleanId(input.variantId, 'Бараа');
  const d = Number(input.deduction);
  if (!Number.isInteger(d) || d < 0 || d > 100_000_000) throw badRequest('Суутгал 0 эсвэл түүнээс их бүхэл тоо (төгрөг)');
  const l = await loadLoan(db, id);
  const line = l.lines.find((x) => x.variantId === variantId);
  if (!line) throw notFound('Мөр олдсонгүй');
  assertNotSelf(actor, l.staffId, 'суутгалыг өөрөө засах');
  if (l.status !== 'ISSUED') throw conflict('Нээлттэй зээлийн суутгалыг л засна');
  // Аудит #149: суутгал барааны үнээс их байж болохгүй
  if (line.unitPrice !== null && d > line.unitPrice) throw badRequest(`Суутгал барааны үнээс (${line.unitPrice.toLocaleString('en-US')}₮) их байж болохгүй`, 'deduction_over');
  if (line.deduction === d) return l;
  await db.$transaction(async (tx) => {
    // Аудит А11: тэр мөчид цалингаар суутгагдсан (хаагдсан) зээлийн суутгалыг өөрчлөхгүй
    await tx.$queryRaw`SELECT id FROM "StaffLoan" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.staffLoan.findUniqueOrThrow({ where: { id } });
    if (cur.status !== 'ISSUED') throw conflict('Нээлттэй зээлийн суутгалыг л засна');
    await tx.staffLoanLine.update({ where: { id: line.id }, data: { deduction: d } });
    await writeAudit(actor, 'loan.deduction_changed', 'StaffLoan', String(id), { staff: l.staffName, variantId, from: line.deduction, to: d }, tx, ['loan']);
  });
  return loadLoan(db, id);
}

/**
 * Буцаагаагүй барааг цалингаас суутгах — ЗӨВХӨН цалин түгжихэд (Модуль 7б). Аудит №7 (эзний шийдвэр): зээлийн хуудасны тусдаа
 * «Цалингаас суутгах» товч хасагдсан — бараа хасагдаад мөнгө цалинд хүрдэггүй байв. Эрхийг дуудагч шалгана.
 */
export async function chargeLoanTx(tx: Prisma.TransactionClient, actor: UserActor, id: number, note: string | null) {
  {
    // Аудит #149: зээлийг эхлээд түгжинэ — зэрэг буцаалт / суутгал засварын хуучин тоогоор суутгахгүй
    await tx.$queryRaw`SELECT id FROM "StaffLoan" WHERE id = ${id} FOR UPDATE`;
    const l = await loadLoan(tx, id);
    if (l.status === 'CLOSED') return { loan: l, duplicate: true, amount: 0 };
    if (l.status !== 'ISSUED') throw conflict('Энэ зээл нээлттэй биш байна');
    const ok = await tx.staffLoan.updateMany({ where: { id, status: 'ISSUED' }, data: { status: 'CLOSED', closedAt: new Date(), decidedNote: note } });
    if (!ok.count) return { loan: await loadLoan(tx, id), duplicate: true, amount: 0 };
    const staffLoc = await staffLocationId(tx, { id: l.staffId, name: l.staffName });
    let amount = 0;
    const moves = [];
    for (const line of l.lines) {
      const q = outstanding(line);
      if (q <= 0) continue;
      amount += q * (line.deduction ?? 0);
      await tx.staffLoanLine.update({ where: { id: line.id }, data: { chargedQty: { increment: q } } });
      moves.push({ type: 'LOAN_CHARGE' as const, variantId: line.variantId, qty: q, fromId: staffLoc, toId: null, note: `${l.staffName} — цалингаас ${q} × ${line.deduction ?? 0}₮` });
    }
    await applyMoves(tx, actor, { type: 'loan', id }, moves);
    await writeAudit(actor, 'loan.charged', 'StaffLoan', String(id), { staff: l.staffName, amount, items: moves.reduce((s, m) => s + m.qty, 0), note }, tx, ['loan', 'money']);
    return { loan: await loadLoan(tx, id), duplicate: false, amount };
  }
}

export async function setLoanDiscount(actor: UserActor, value: unknown) {
  requireRole(canLoanFinance(actor.roles), 'Хямдралыг Супер админ, Нягтлан засна');
  const v = Number(value);
  // Аудит #149: хөнгөлөлт 16,000₮-өөс бага (үнэтэй бараанд л хэрэглэгдэнэ)
  if (!Number.isInteger(v) || v < 0 || v >= LOAN_DISCOUNT_MIN_PRICE) throw badRequest(`Хямдрал 0 – ${(LOAN_DISCOUNT_MIN_PRICE - 1).toLocaleString('en-US')}₮`);
  const old = await getLoanDiscount();
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: LOAN_DISCOUNT_KEY }, create: { key: LOAN_DISCOUNT_KEY, value: v, updatedById: actor.id }, update: { value: v, updatedById: actor.id } });
    await writeAudit(actor, 'settings.loan_discount', 'AppSetting', LOAN_DISCOUNT_KEY, { from: old, to: v }, tx, ['loan', 'money']);
  });
  return { loanDiscount: v };
}

export async function listLoans(actor: UserActor, params: { status?: string; mine?: boolean; page?: number }) {
  requireRole(canView(actor.roles, 'loans'));
  const all = canSeeAllLoans(actor.roles) && !params.mine;
  const where: Prisma.StaffLoanWhereInput = all ? {} : { staffId: actor.id };
  if (params.status === 'open') where.status = { in: ['REQUESTED', 'ISSUED'] };
  else if (params.status && params.status !== 'all') {
    // Аудит А11: буруу төлөв → 500 биш, ойлгомжтой алдаа
    if (!['REQUESTED', 'ISSUED', 'CLOSED', 'REJECTED', 'CANCELLED'].includes(params.status)) throw badRequest('Төлөв буруу');
    where.status = params.status as LoanStatus;
  }
  const page = Math.max(1, Math.min(10_000, Math.floor(Number(params.page) || 1)));
  const [total, rows] = await Promise.all([
    db.staffLoan.count({ where }),
    db.staffLoan.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * 30, take: 30, include: { lines: true } }),
  ]);
  const info = await variantInfo([...new Set(rows.flatMap((r) => r.lines.map((l) => l.variantId)))]);
  // Аудит #149: олгохдоо тухайн хүнд одоо байгаа зээл (ширхэг, дүн); 30+ хоног хаагдаагүй зээл
  const reqStaff = canOperateStock(actor.roles) ? [...new Set(rows.filter((r) => r.status === 'REQUESTED').map((r) => r.staffId))] : [];
  const holds = Object.fromEntries(await Promise.all(reqStaff.map(async (sid) => [sid, await staffLoanSummary(sid)] as const)));
  const oldOpen = canSeeAllLoans(actor.roles) ? await db.staffLoan.count({ where: { status: 'ISSUED', issuedAt: { lt: new Date(Date.now() - LOAN_OLD_DAYS * 86_400_000) } } }) : 0;
  return {
    total, page, pageSize: 30, loanDiscount: await getLoanDiscount(), holds, oldOpen, oldDays: LOAN_OLD_DAYS, minDiscountPrice: LOAN_DISCOUNT_MIN_PRICE,
    can: { request: canRequestLoan(actor.roles), operate: canOperateStock(actor.roles), finance: canLoanFinance(actor.roles), all: canSeeAllLoans(actor.roles) },
    items: rows.map((l) => serializeLoan(l, info)),
  };
}

export async function getLoan(actor: UserActor, idInput: unknown) {
  const l = await loadLoan(db, cleanId(idInput, 'Зээл'));
  if (l.staffId !== actor.id && !canSeeAllLoans(actor.roles)) throw forbidden();
  return serializeLoan(l, await variantInfo(l.lines.map((x) => x.variantId)));
}

export const LOAN_OLD_DAYS = 30;
function serializeLoan(l: Awaited<ReturnType<typeof loadLoan>>, info: Awaited<ReturnType<typeof variantInfo>>) {
  const lines = l.lines.map((x) => ({
    id: x.id, variantId: x.variantId, ...info.get(x.variantId), qty: x.qty, returnedQty: x.returnedQty, chargedQty: x.chargedQty, outstanding: outstanding(x),
    unitPrice: x.unitPrice, deduction: x.deduction,
  }));
  return {
    id: l.id, staffId: l.staffId, staffName: l.staffName, status: l.status, statusLabel: LOAN_STATUS_LABEL[l.status], note: l.note, decidedNote: l.decidedNote,
    requestedAt: l.requestedAt, issuedAt: l.issuedAt, issuedBy: l.issuedByName, closedAt: l.closedAt, warehouseId: l.warehouseId,
    lines, outstandingQty: lines.reduce((s, x) => s + x.outstanding, 0),
    old: l.status === 'ISSUED' && !!l.issuedAt && Date.now() - l.issuedAt.getTime() > LOAN_OLD_DAYS * 86_400_000,
    /** Буцаагаагүй бол цалингаас суутгах дүн */
    deductionDue: lines.reduce((s, x) => s + x.outstanding * (x.deduction ?? 0), 0),
  };
}
