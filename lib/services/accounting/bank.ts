import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit, SYSTEM_ACTOR, type Actor } from '../../audit';
import { canBankImport, canView } from '../../permissions';
import { ubDay, ubDayStart, isYmd } from '../../ubdate';
import { inTx, lockOrder, orderSettings, paidOrderData, type UserActor } from '../orders/core';
import { enqueueMeta, skipMeta } from '../orders/meta';
import { bustCounts } from '../orders/queries';
import { addDays } from '../delivery/core';

type Tx = Prisma.TransactionClient;

/**
 * Модуль 6 — Банкны импорт (Хаан банк), одоохондоо ХУУЧНААР НЬ (#83) + аюулгүй байдлын засвар:
 *   CSV (огноо, утга, дүн) эсвэл Gmail (Хаан банкны SMS/имэйл) → гүйлгээ; утасны дугаар (8 орон, 8/9-өөр эхэлсэн) + дүнгээр
 *   «Төлбөр хүлээж буй» захиалгыг олж (хамгийн эртнийх), төлсөн нийлбэр ≥ дүн бол «Мөнгө орсон» (Meta илгээгдэнэ). Дутуу бол «Хэсэгчлэн».
 *   Давхардал: ижил имэйл, эсвэл ижил өдөр + дүн + утас (утасгүй бол утга) — тухайн утсанд өөр хүлээгдэж буй захиалга байхгүй бол.
 * Засвар: зөвхөн ОРЛОГО (мөнгө гарсан гүйлгээ алгасна), бүх үйлдэл эрхтэй, «бүгдийг устгах» байхгүй, захиалгын дугаар СОЛИГДОХГҮЙ
 * (хуучин шиг цуцалж шинээр үүсгэхгүй — «Мөнгө орсон» болоход л болно).
 */
export const BANK_STATUS_LABEL: Record<string, string> = {
  MATCHED: 'Таарсан', UNMATCHED: 'Таараагүй', PARTIAL_PAYMENT: 'Хэсэгчлэн', EXCESS_AMOUNT: 'Илүү', DUPLICATE: 'Давхардсан', REFUNDED: 'Буцаасан',
};
const LINKED = ['MATCHED', 'EXCESS_AMOUNT', 'PARTIAL_PAYMENT'];
const assertView = (a: UserActor) => { if (!canView(a.roles, 'bank-import')) throw forbidden(); };
const assertEdit = (a: UserActor) => { if (!canBankImport(a.roles)) throw forbidden('Банкны хуулга импортлох, тааруулах эрх байхгүй'); };

// ───────────────────────── Задлагч (хуучин khan-bank-parser шиг) ─────────────────────────

export function extractPhones(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[^0-9*])([5-9]\d{7})(?=[^0-9]|$)/g; // 5, 6, 7, 8, 9-өөр эхэлсэн 8 оронтой
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (!out.includes(m[1]!)) out.push(m[1]!);
  // Зай / зураас / цэгтэй бичсэн (#126): «9988-7711», «9988 7711», «9988.7711», «99 88 77 11» — урт тооны хэсэг бол авахгүй
  const sep = [
    /(?<![\d*])([5-9]\d{3})[ \-.](\d{4})(?![ \-.]?\d)/g,
    /(?<![\d*])([5-9]\d)[ \-.](\d{2})[ \-.](\d{2})[ \-.](\d{2})(?![ \-.]?\d)/g,
  ];
  for (const r of sep) while ((m = r.exec(text)) !== null) { const p = m.slice(1).join(''); if (!out.includes(p)) out.push(p); }
  return out;
}

export interface ParsedTx { amount: number; date: Date; description: string; phone: string | null; income: boolean }

/**
 * Хаан банкны мессеж (хуучин ERP шиг ЗӨВХӨН «Khan Bank» гэсэн толгойтой). Бусад имэйл (сурталчилгаа г.м.) → null.
 *   Шинэ хэлбэр: «Khan Bank:Tany 5***2327 dansand ORLOGO:18,000.00MNT orj ULDEGDEL:1,600,559.00MNT bolloo.Utga:80020023Sainshand»
 *   Хуучин хэлбэр: «Khan Bank: ... 35,000.00 MNT orlogo orson. Guilgeenii utga: 99112233 ...»
 * Утас зөвхөн гүйлгээний утгаас (данс, үлдэгдлээс биш). Утга хоосон / өөр бичсэн бол утасгүй → «Таараагүй» (гараар тааруулна).
 */
export function parseKhanMessage(text: string, when: Date = new Date()): ParsedTx | null {
  const n = text.replace(/\r?\n/g, ' ').replace(/[ \t\u00a0]+/g, ' ').trim();
  const head = n.search(/Khan\s*Bank/i);
  if (head < 0) return null;
  const body = n.slice(head);
  let income = true;
  let m = body.match(/ORLOGO\s*:?\s*([\d,]+(?:\.\d{1,2})?)\s*MNT/i) ?? body.match(/([\d,]+(?:\.\d{1,2})?)\s*MNT\s+orlogo/i);
  if (!m) {
    m = body.match(/ZARLAGA\s*:?\s*([\d,]+(?:\.\d{1,2})?)\s*MNT/i) ?? body.match(/([\d,]+(?:\.\d{1,2})?)\s*MNT\s+zarlaga/i);
    if (!m) return null;
    income = false;
  }
  const amount = Math.round(parseFloat(m[1]!.replace(/,/g, '')));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const u = body.match(/(?:Guilgeenii\s+)?utga\s*:\s*(.*)$/i);
  const description = (u ? u[1]! : '').replace(/\s*Uldegdel\s*:?\s*[\d,]+(?:\.\d{1,2})?\s*MNT\.?/i, '').trim().replace(/\.$/, '').slice(0, 300);
  return { amount, date: when, description: description || 'Хаан банк (утгагүй)', phone: description ? extractPhones(description)[0] ?? null : null, income };
}

/** Нэг имэйлд олон мессеж байж болно — «Khan Bank» бүрээр хувааж задлана */
export function parseKhanMessages(text: string, when: Date = new Date()): ParsedTx[] {
  const parts = text.split(/(?=Khan\s*Bank)/i).filter((x) => /Khan\s*Bank/i.test(x));
  return parts.map((x) => parseKhanMessage(x, when)).filter((x): x is ParsedTx => !!x);
}

/** CSV мөр: огноо, утга, дүн (хуучин шиг эхний мөр гарчиг). Дүн «-»-тэй (зарлага) бол алгасна */
export function parseCsv(text: string): { rows: { date: Date; description: string; amount: number }[]; skipped: number; debits: number } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const rows: { date: Date; description: string; amount: number }[] = [];
  let skipped = 0, debits = 0;
  for (let i = 1; i < lines.length && i <= 20_001; i++) {
    const cells = splitCsvLine(lines[i]!);
    if (cells.length < 3) { skipped++; continue; }
    const amountRaw = cells[cells.length - 1]!.trim();
    const description = cells.slice(1, cells.length - 1).join(',').trim().slice(0, 500);
    if (/^\s*-/.test(amountRaw) || /^\(.*\)$/.test(amountRaw)) { debits++; continue; }
    const amount = Math.round(Number(amountRaw.replace(/[^\d.]/g, '')));
    const date = parseDate(cells[0]!.trim());
    if (!amount || amount <= 0 || !date) { skipped++; continue; }
    rows.push({ date, description, amount });
  }
  return { rows, skipped, debits };
}
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
/** 2026-11-11, 2026.11.11 14:30, 2026/11/11, 11/11/2026 — Улаанбаатарын цагаар */
export function parseDate(s: string): Date | null {
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return ub(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 12), +(m[5] ?? 0), +(m[6] ?? 0));
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return ub(+m[3]!, +m[2]!, +m[1]!, +(m[4] ?? 12), +(m[5] ?? 0), 0);
  return null;
}
function ub(y: number, mo: number, d: number, h: number, mi: number, se: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, se));
}

// ───────────────────────── Импорт ба тааруулах ─────────────────────────

export interface TxIn { date: Date; description: string; amount: number; phone?: string | null; emailMessageId?: string | null }

/** Захиалгын төлсөн нийлбэр (давхардсан, буцаасныг тооцохгүй) */
async function paidFor(tx: Tx, orderId: number, exceptId?: number) {
  const a = await tx.bankTransaction.aggregate({ where: { orderId, status: { in: LINKED }, isDuplicate: false, refunded: false, ...(exceptId ? { id: { not: exceptId } } : {}) }, _sum: { amount: true } });
  return a._sum.amount ?? 0;
}

/** Мөнгө орсон: «Төлбөр хүлээж буй» → «Шинэ», урьдчилж төлсөн (Модуль 3-ын markPaid-тай ижил, Meta илгээгдэнэ). Дугаар солигдохгүй */
async function markPaidByBank(tx: Tx, actor: Actor, orderId: number, paid: number, how: string) {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.status !== 'PENDING_PAYMENT') return false;
  const pd = paidOrderData(o);
  await tx.order.update({ where: { id: orderId }, data: { ...pd.data, paidAmount: paid } });
  await enqueueMeta(tx, orderId);
  await writeAudit(actor, 'order.paid', 'Order', String(orderId), { number: o.number, total: o.total, paid, by: how, ...(pd.deliveryChange ? { deliveryDate: pd.deliveryChange } : {}) }, tx, ['order', 'money', 'bank']);
  return true;
}

/** Нэг захиалгад холбогдсон бүх гүйлгээний төлвийг нийлбэрээр нь шинэчилнэ */
async function restatus(tx: Tx, orderId: number) {
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { total: true } });
  if (!o) return;
  const paid = await paidFor(tx, orderId);
  const st = paid >= o.total ? (paid > o.total ? 'EXCESS_AMOUNT' : 'MATCHED') : 'PARTIAL_PAYMENT';
  await tx.bankTransaction.updateMany({ where: { orderId, status: { in: LINKED }, isDuplicate: false, refunded: false }, data: { status: st } });
}

/** Захиалгын дүн өөрчлөгдсөний дараа (урьдчилж төлсөн): гүйлгээнүүдийн төлөв Таарсан / Илүү (#124-1) */
export async function restatusOrder(orderId: number) {
  return inTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(6::int4, 0::int4)`;
    await restatus(tx, orderId);
  });
}

/** Утсаар «Төлбөр хүлээж буй» захиалга хайж тааруулах (хуучин matchTransaction) */
async function autoMatch(tx: Tx, actor: Actor, txId: number, phones: string[]): Promise<'MATCHED' | 'PARTIAL' | null> {
  const t = await tx.bankTransaction.findUniqueOrThrow({ where: { id: txId } });
  if (t.isDuplicate || t.refunded) return null;
  for (const phone of phones) {
    const orders = await tx.order.findMany({ where: { status: 'PENDING_PAYMENT', OR: [{ phone }, { extraPhone: phone }] }, orderBy: { createdAt: 'asc' }, take: 5, select: { id: true, total: true } });
    for (const o of orders) {
      await lockOrder(tx, o.id);
      const paid = (await paidFor(tx, o.id)) + t.amount;
      await tx.bankTransaction.update({ where: { id: txId }, data: { orderId: o.id, phone, status: 'PARTIAL_PAYMENT', matchedAt: new Date(), matchedByName: 'Автомат' } });
      await restatus(tx, o.id);
      if (paid >= o.total) { await markPaidByBank(tx, actor, o.id, paid, 'Банкны хуулга таарсан'); return 'MATCHED'; }
      return 'PARTIAL';
    }
  }
  return null;
}

/**
 * Өмнө нь утасгүй («Таараагүй») орсон гүйлгээний утгаас утсыг дахин олж тааруулна (#126 — «9988-7711» хэлбэрийг шинээр таньдаг болсон).
 * Сервер асахад нэг удаа (сүүлийн 60 хоног). Давхардсан, буцаасан гүйлгээнд хүрэхгүй.
 */
export async function rescanUnmatched(): Promise<{ scanned: number; phones: number; matched: number }> {
  const rows = await db.bankTransaction.findMany({ where: { status: 'UNMATCHED', phone: null, isDuplicate: false, refunded: false, txDate: { gte: new Date(Date.now() - 60 * 86_400_000) } }, select: { id: true, description: true }, take: 2000 });
  let phones = 0, matched = 0;
  for (const r of rows) {
    const ps = extractPhones(r.description);
    if (!ps.length) continue;
    phones++;
    const m = await inTx(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(6::int4, 0::int4)`;
      const n = await tx.bankTransaction.updateMany({ where: { id: r.id, status: 'UNMATCHED', phone: null }, data: { phone: ps[0]! } });
      if (!n.count) return null;
      return autoMatch(tx, SYSTEM_ACTOR, r.id, ps);
    });
    if (m) matched++;
  }
  if (matched) bustCounts();
  return { scanned: rows.length, phones, matched };
}

export async function importTransactions(actor: Actor, list: TxIn[], source: 'CSV' | 'GMAIL') {
  const res = { imported: 0, matched: 0, partial: 0, duplicates: 0, errors: [] as string[] };
  for (const raw of list.slice(0, 5000)) {
    try {
      await inTx(async (tx) => {
        // Нэг дор олон импорт зэрэг ажиллахад давхардал шалгалт зөрөхгүй
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(6::int4, 0::int4)`;
        const description = String(raw.description ?? '').trim().slice(0, 500) || 'Хаан банк гүйлгээ';
        const amount = Math.round(Number(raw.amount));
        if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Дүн буруу');
        const phones = raw.phone ? [raw.phone] : extractPhones(description);
        const phone = phones[0] ?? null;
        if (raw.emailMessageId && (await tx.bankTransaction.findUnique({ where: { emailMessageId: raw.emailMessageId } }))) { res.duplicates++; return; }
        const day = ubDay(raw.date);
        // Gmail: мессеж бүр өөрийн дугаартай тул яг давхардлыг дугаараар нь л (утгагүй ижил дүнтэй 2 өөр хүнийг давхардал гэхгүй)
        const same = raw.emailMessageId ? [] : await tx.bankTransaction.findMany({
          where: { txDate: { gte: ubDayStart(day), lt: ubDayStart(addDays(day, 1)) }, amount, isDuplicate: false, ...(phone ? { phone } : { phone: null, description }) },
          select: { orderId: true },
        });
        let dup = false;
        if (same.length && phone) {
          const linked = new Set(same.map((s) => s.orderId).filter(Boolean));
          const pending = await tx.order.findMany({ where: { status: 'PENDING_PAYMENT', OR: [{ phone }, { extraPhone: phone }] }, select: { id: true } });
          dup = pending.filter((o) => !linked.has(o.id)).length === 0;
        } else if (same.length) dup = true;
        const t = await tx.bankTransaction.create({ data: {
          txDate: raw.date, description, amount, phone, source, emailMessageId: raw.emailMessageId ?? null, importedByName: actor.name,
          ...(dup ? { isDuplicate: true, status: 'DUPLICATE' } : {}),
        } });
        if (dup) { res.duplicates++; return; }
        res.imported++;
        const m = phones.length ? await autoMatch(tx, actor, t.id, phones) : null;
        if (m === 'MATCHED') res.matched++; else if (m === 'PARTIAL') res.partial++;
      });
    } catch (e) {
      res.errors.push(`${String(raw.description ?? '').slice(0, 40)}: ${(e as Error).message}`);
      if (res.errors.length > 50) break;
    }
  }
  if (res.imported || res.matched) bustCounts();
  await writeAudit(actor, 'bank.imported', 'BankTransaction', source, { source, ...res, errors: res.errors.length } as unknown as Prisma.InputJsonValue, db, ['money', 'bank']);
  return res;
}

export async function importCsv(actor: UserActor, input: { text?: unknown }) {
  assertEdit(actor);
  const text = String(input.text ?? '');
  if (!text.trim()) throw badRequest('CSV файл хоосон байна');
  if (text.length > 5_000_000) throw badRequest('Файл хэт том (5MB хүртэл)');
  const p = parseCsv(text);
  if (!p.rows.length) throw badRequest(`Импортлох орлого олдсонгүй (зарлага ${p.debits}, буруу мөр ${p.skipped}). Багана: огноо, утга, дүн`, 'empty');
  const r = await importTransactions(actor, p.rows, 'CSV');
  return { ...r, debitsSkipped: p.debits, badRows: p.skipped };
}

/** Шинэ «Төлбөр хүлээж буй» захиалга / дүн өөрчлөгдсөн үед: тухайн утасны таараагүй гүйлгээгээр тааруулах (хуучин matchPendingOrderWithTransactions) */
export async function matchOrderWithTransactions(orderId: number) {
  return inTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(6::int4, 0::int4)`;
    if (!(await lockOrder(tx, orderId))) return false;
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, status: true, total: true, phone: true, extraPhone: true } });
    if (o.status !== 'PENDING_PAYMENT') return false;
    let paid = await paidFor(tx, orderId);
    if (paid >= o.total) { await restatus(tx, orderId); return markPaidByBank(tx, SYSTEM_ACTOR, orderId, paid, 'Банкны хуулга (дүн өөрчлөгдсөн)'); }
    const phones = [o.phone, o.extraPhone].filter((x): x is string => !!x);
    const free = await tx.bankTransaction.findMany({ where: { phone: { in: phones }, status: 'UNMATCHED', isDuplicate: false, refunded: false }, orderBy: { txDate: 'asc' }, take: 20 });
    for (const t of free) {
      paid += t.amount;
      await tx.bankTransaction.update({ where: { id: t.id }, data: { orderId, status: 'PARTIAL_PAYMENT', matchedAt: new Date(), matchedByName: 'Автомат' } });
      if (paid >= o.total) break;
    }
    await restatus(tx, orderId);
    if (paid >= o.total) return markPaidByBank(tx, SYSTEM_ACTOR, orderId, paid, 'Банкны хуулга автомат таарсан');
    return false;
  });
}

/** «Гараар тааруулах»: захиалгын дугаараар (хуучин шиг; хуучин захиалгыг цуцалж шинээр үүсгэхгүй) */
export async function manualMatch(actor: UserActor, idIn: unknown, input: { orderNumber?: unknown }) {
  assertEdit(actor);
  const id = Number(idIn);
  const number = String(input.orderNumber ?? '').trim();
  if (!/^\d{4,12}$/.test(number)) throw badRequest('Захиалгын дугаараа оруулна уу');
  const r = await inTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(6::int4, 0::int4)`;
    const t = await tx.bankTransaction.findUnique({ where: { id } });
    if (!t) throw notFound('Гүйлгээ олдсонгүй');
    if (t.refunded) throw conflict('Буцаасан гүйлгээг тааруулахгүй', 'refunded');
    const o = await tx.order.findUnique({ where: { number }, select: { id: true, number: true, status: true, total: true, prepaid: true } });
    if (!o) throw notFound('Захиалга олдсонгүй');
    await lockOrder(tx, o.id);
    const prev = t.orderId;
    await tx.bankTransaction.update({ where: { id }, data: { orderId: o.id, isDuplicate: false, status: 'MATCHED', matchedAt: new Date(), matchedByName: actor.name } });
    if (prev && prev !== o.id) {
      await restatus(tx, prev);
      // Гүйлгээ өөр захиалгад шилжвэл (#124-И): хуучин захиалга оноогдоогүй, төлбөр нь дутуу болсон бол «Төлбөр хүлээж буй» руу буцна
      await lockOrder(tx, prev);
      const po = await tx.order.findUnique({ where: { id: prev } });
      const left = await paidFor(tx, prev);
      if (po && po.status === 'NEW' && po.prepaid && !po.driverId && !po.handoverId && left < po.total) {
        const { waitDays } = await orderSettings();
        await tx.order.update({ where: { id: prev }, data: { status: 'PENDING_PAYMENT', prepaid: false, paidAmount: left, confirmedAt: null, paymentDeadline: new Date(Date.now() + waitDays * 86_400_000), version: { increment: 1 } } });
        await skipMeta(tx, prev);
        await writeAudit(actor, 'order.paid_undone', 'Order', String(prev), { number: po.number, note: `Банкны гүйлгээ №${o.number} руу шилжсэн`, paid: left, total: po.total }, tx, ['order', 'money', 'bank']);
      }
    }
    await restatus(tx, o.id);
    const paid = await paidFor(tx, o.id);
    let paidMarked = false;
    if (o.status === 'PENDING_PAYMENT' && paid >= o.total) paidMarked = await markPaidByBank(tx, actor, o.id, paid, 'Гараар тааруулсан');
    await writeAudit(actor, 'bank.manual_match', 'BankTransaction', String(id), { amount: t.amount, order: o.number, prevOrderId: prev, paid, total: o.total, paidMarked }, tx, ['money', 'bank']);
    return { transaction: await tx.bankTransaction.findUniqueOrThrow({ where: { id } }), paid, total: o.total, paidMarked };
  });
  bustCounts();
  return r;
}

/** «Буцаасан» тэмдэг (үйлчлүүлэгчид мөнгийг нь буцааж өгсөн) */
export async function setRefunded(actor: UserActor, idIn: unknown, input: { refunded?: unknown }) {
  assertEdit(actor);
  const id = Number(idIn);
  // «Буцаасан» нь эцсийн (#127): болиулахгүй — буцаалт хийсэн мөнгийг дахин захиалгад тааруулах эрсдэлээс сэргийлнэ
  if (input.refunded === false) throw conflict('«Буцаасан» гүйлгээг буцааж болиулах боломжгүй', 'refund_final');
  const refunded = true;
  return inTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(6::int4, 0::int4)`;
    const t = await tx.bankTransaction.findUnique({ where: { id } });
    if (!t) throw notFound('Гүйлгээ олдсонгүй');
    if (t.refunded) return { ok: true };
    await tx.bankTransaction.update({ where: { id }, data: { refunded } });
    if (t.orderId) await restatus(tx, t.orderId);
    await writeAudit(actor, refunded ? 'bank.refunded' : 'bank.unrefunded', 'BankTransaction', String(id), { amount: t.amount, phone: t.phone }, tx, ['money', 'bank']);
    return { ok: true };
  });
}

// ───────────────────────── Жагсаалт, статистик, экспорт ─────────────────────────

export interface BankFilter { tab?: string; q?: string; from?: string; to?: string; page?: number }

function where(f: BankFilter): Prisma.BankTransactionWhereInput {
  const w: Prisma.BankTransactionWhereInput[] = [];
  const tab = f.tab ?? 'all';
  if (tab === 'REFUNDED') w.push({ refunded: true });
  else if (tab === 'DUPLICATE') w.push({ isDuplicate: true, refunded: false });
  else if (tab in BANK_STATUS_LABEL) w.push({ status: tab, isDuplicate: false, refunded: false });
  if (f.q) {
    const q = f.q.trim().slice(0, 60);
    const or: Prisma.BankTransactionWhereInput[] = [{ description: { contains: q, mode: 'insensitive' } }, { phone: { startsWith: q } }];
    if (/^\d+$/.test(q) && q.length <= 9) or.push({ amount: Number(q) });
    w.push({ OR: or });
  }
  if (f.from && isYmd(f.from)) w.push({ txDate: { gte: ubDayStart(f.from) } });
  if (f.to && isYmd(f.to)) w.push({ txDate: { lt: ubDayStart(addDays(f.to, 1)) } });
  return w.length ? { AND: w } : {};
}

export async function listTransactions(actor: UserActor, f: BankFilter) {
  assertView(actor);
  const page = Math.max(1, Math.floor(Number(f.page) || 1));
  const w = where(f);
  const [items, total] = await Promise.all([
    db.bankTransaction.findMany({ where: w, orderBy: [{ txDate: 'desc' }, { id: 'desc' }], skip: (page - 1) * 50, take: 50 }),
    db.bankTransaction.count({ where: w }),
  ]);
  const orders = await db.order.findMany({ where: { id: { in: items.map((t) => t.orderId).filter((x): x is number => !!x) } }, select: { id: true, number: true, total: true, phone: true, status: true, prepaid: true } });
  const om = new Map(orders.map((o) => [o.id, o]));
  return {
    page, total, pages: Math.max(1, Math.ceil(total / 50)), canEdit: canBankImport(actor.roles),
    items: items.map((t) => ({ ...t, statusLabel: t.refunded ? BANK_STATUS_LABEL.REFUNDED : t.isDuplicate ? BANK_STATUS_LABEL.DUPLICATE : BANK_STATUS_LABEL[t.status] ?? t.status, order: t.orderId ? om.get(t.orderId) ?? null : null })),
  };
}

export async function bankStats(actor: UserActor, f: { from?: string; to?: string }) {
  assertView(actor);
  const base = where({ from: f.from, to: f.to });
  const agg = (extra: Prisma.BankTransactionWhereInput) => db.bankTransaction.aggregate({ where: { AND: [base, extra] }, _count: true, _sum: { amount: true } });
  const [all, matched, unmatched, partial, excess, dup, refunded] = await Promise.all([
    agg({}), agg({ status: 'MATCHED', isDuplicate: false, refunded: false }), agg({ status: 'UNMATCHED', isDuplicate: false, refunded: false }),
    agg({ status: 'PARTIAL_PAYMENT', isDuplicate: false, refunded: false }), agg({ status: 'EXCESS_AMOUNT', isDuplicate: false, refunded: false }),
    agg({ isDuplicate: true, refunded: false }), agg({ refunded: true }),
  ]);
  const v = (a: typeof all) => ({ count: a._count, amount: a._sum.amount ?? 0 });
  return { total: v(all), matched: v(matched), unmatched: v(unmatched), partial: v(partial), excess: v(excess), duplicate: v(dup), refunded: v(refunded) };
}

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export async function exportCsv(actor: UserActor, f: BankFilter) {
  assertView(actor);
  const rows = await db.bankTransaction.findMany({ where: where(f), orderBy: { txDate: 'desc' }, take: 50_000 });
  const orders = await db.order.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.orderId).filter((x): x is number => !!x))] } }, select: { id: true, number: true, total: true } });
  const om = new Map(orders.map((o) => [o.id, o]));
  const head = ['Огноо', 'Утга', 'Дүн', 'Утас', 'Төлөв', 'Захиалга', 'Захиалгын дүн', 'Эх сурвалж'];
  const fmt = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
  const lines = rows.map((r) => [fmt(r.txDate), r.description, r.amount, r.phone ?? '', r.refunded ? 'Буцаасан' : r.isDuplicate ? 'Давхардсан' : BANK_STATUS_LABEL[r.status] ?? r.status, r.orderId ? om.get(r.orderId)?.number ?? '' : '', r.orderId ? om.get(r.orderId)?.total ?? '' : '', r.source].map(csvCell).join(','));
  return '﻿' + [head.join(','), ...lines].join('\n');
}

/** «Дүн өөрчлөгдсөн»: гүйлгээтэй холбогдсон захиалгын одоогийн дүн ≠ төлсөн нийлбэр (оператор дүнг сольсон гэх мэт) */
export async function priceChanges(actor: UserActor, p: { page?: number }) {
  assertView(actor);
  const page = Math.max(1, Math.floor(Number(p.page) || 1));
  const rows = await db.$queryRaw<{ id: number; number: string; phone: string; total: number; status: string; prepaid: boolean; paid: number; operatorName: string; updatedAt: Date; n: number }[]>`
    WITH s AS (SELECT "orderId", sum(amount)::int AS paid FROM "BankTransaction" WHERE "orderId" IS NOT NULL AND "isDuplicate" = false AND refunded = false AND status IN ('MATCHED','EXCESS_AMOUNT','PARTIAL_PAYMENT') GROUP BY 1)
    SELECT o.id, o.number, o.phone, o.total, o.status::text AS status, o.prepaid, s.paid, o."operatorName", o."updatedAt", count(*) OVER ()::int AS n
    FROM s JOIN "Order" o ON o.id = s."orderId"
    WHERE s.paid <> o.total AND o.status <> 'CANCELLED'
    ORDER BY o."updatedAt" DESC OFFSET ${(page - 1) * 50} LIMIT 50`;
  return { page, total: rows[0]?.n ?? 0, items: rows.map(({ n: _n, ...r }) => ({ ...r, diff: r.paid - r.total })) };
}

/** «Гараар тааруулах» цонхонд: утас / дугаараар захиалга хайх */
export async function searchOrdersForMatch(actor: UserActor, qIn: unknown) {
  assertEdit(actor);
  const q = String(qIn ?? '').replace(/\D/g, '').slice(0, 12);
  if (q.length < 4) return { items: [] };
  const items = await db.order.findMany({
    where: { OR: [{ number: q }, { phone: q }, { extraPhone: q }] }, orderBy: { createdAt: 'desc' }, take: 20,
    select: { id: true, number: true, phone: true, total: true, status: true, prepaid: true, createdAt: true },
  });
  const paid = await db.bankTransaction.groupBy({ by: ['orderId'], where: { orderId: { in: items.map((i) => i.id) }, status: { in: LINKED }, isDuplicate: false, refunded: false }, _sum: { amount: true } });
  const pm = new Map(paid.map((p) => [p.orderId, p._sum.amount ?? 0]));
  return { items: items.map((i) => ({ ...i, paid: pm.get(i.id) ?? 0 })) };
}
