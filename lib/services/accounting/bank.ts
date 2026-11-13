import { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { writeAudit, SYSTEM_ACTOR, type Actor } from '../../audit';
import { canBankImport, canView } from '../../permissions';
import { ubDay, ubDayStart, isYmd } from '../../ubdate';
import { inTx, lockOrder, orderSettings, paidOrderData, type UserActor } from '../orders/core';
import { enqueueMeta, skipMeta } from '../orders/meta';
import { bustCounts } from '../orders/queries';
import { addDays } from '../delivery/core';
import { withHeavy } from '../../heavy';

type Tx = Prisma.TransactionClient;

/** Аудит #148: банкны нийтлэг түгжээ (6) — 5 сек-ээс удаан хүлээхгүй («Систем түр завгүй»), холболт барьж бусдыг гацаахгүй */
/** Банкны өгөгдөл өөрчлөгдөх бүрт (түгжээ авах бүрт) статистик, «Дүн өөрчлөгдсөн»-ий санах ой хүчингүй */
let bankVer = 0;
async function bankLock(tx: Tx) {
  bankVer++;
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(6::int4, 0::int4)`;
}
/** Аудит #148 (эзний шийдвэр): захиалга үүсэх / утас солиход автоматаар тааруулах мөнгө — сүүлийн 24 цагийнх (хуучныг нягтлан гараар) */
export const AUTO_MATCH_WINDOW_MS = 24 * 3600_000;

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
  // (аудит Б9: «5000 1234 5678 9012», «99 88 77 11 22» шиг урт дугаарын дундаас тасдаж авахгүй — өмнө нь цифр+тусгаарлагч байвал)
  const sep = [
    /(?<![\d*])(?<!\d[ \-.])([5-9]\d{3})[ \-.](\d{4})(?![ \-.]?\d)/g,
    /(?<![\d*])(?<!\d[ \-.])([5-9]\d)[ \-.](\d{2})[ \-.](\d{2})[ \-.](\d{2})(?![ \-.]?\d)/g,
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
  // Аудит #148: дүнг ЗӨВХӨН банкны тогтмол хэсгээс («Utga:»-аас өмнө) уншина — үйлчлүүлэгчийн бичсэн утга дахь
  // «ORLOGO:500,000MNT» гэх мэт бичвэрийг хэзээ ч дүн гэж уншихгүй
  const ui = body.search(/(?:Guilgeenii\s+)?utga\s*:/i);
  const pre = ui >= 0 ? body.slice(0, ui) : body;
  let income = true;
  let m = pre.match(/ORLOGO\s*:?\s*([\d,]+(?:\.\d{1,2})?)\s*MNT/i) ?? pre.match(/([\d,]+(?:\.\d{1,2})?)\s*MNT\s+orlogo/i);
  if (!m) {
    m = pre.match(/ZARLAGA\s*:?\s*([\d,]+(?:\.\d{1,2})?)\s*MNT/i) ?? pre.match(/([\d,]+(?:\.\d{1,2})?)\s*MNT\s+zarlaga/i);
    if (!m) return null;
    income = false;
  }
  // Банкны хэсэгт хоёр дүн байвал (хачин хэлбэр) — хүлээн авахгүй (нягтлан гараар)
  if ((pre.match(/(?:ORLOGO|ZARLAGA)\s*:?\s*[\d,]+(?:\.\d{1,2})?\s*MNT|[\d,]+(?:\.\d{1,2})?\s*MNT\s+(?:orlogo|zarlaga)/gi) ?? []).length > 1) return null;
  const amount = Math.round(parseFloat(m[1]!.replace(/,/g, '')));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const u = body.match(/(?:Guilgeenii\s+)?utga\s*:\s*(.*)$/i);
  const description = (u ? u[1]! : '').replace(/\s*Uldegdel\s*:?\s*[\d,]+(?:\.\d{1,2})?\s*MNT\.?/i, '').trim().replace(/\.$/, '').slice(0, 300);
  return { amount, date: when, description: description || 'Хаан банк (утгагүй)', phone: description ? extractPhones(description)[0] ?? null : null, income };
}

/** Аудит #148 (эзний шийдвэр): НЭГ имэйл = НЭГ гүйлгээ (утга дотор «Khan Bank» гэж бичсэн ч хоёр дахь гүйлгээ болгож хуваахгүй) */
export function parseKhanMessages(text: string, when: Date = new Date()): ParsedTx[] {
  const p = parseKhanMessage(text, when);
  return p ? [p] : [];
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
  const a = await tx.bankTransaction.aggregate({ where: { orderId, status: { in: LINKED }, isDuplicate: false, refunded: false, ...(exceptId ? { id: { not: exceptId } } : {}) }, _sum: { amount: true, excessRefunded: true } });
  // Илүүг буцаасан дүн (#129) төлсөн дүнгээс хасагдана
  return (a._sum.amount ?? 0) - (a._sum.excessRefunded ?? 0);
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
    await bankLock(tx);
    await restatus(tx, orderId);
  });
}

/**
 * Аудит Б1 (эзний шийдвэр): цуцлагдсан захиалгад таарсан мөнгө «Таараагүй» руу буцна — тэр утсаар шинэ захиалга
 * («Төлбөр хүлээж буй») байвал автоматаар түүнд таарна, үгүй бол нягтлан «Буцаасан» гэж тэмдэглэнэ / гараар тааруулна.
 */
export async function releaseCancelledOrderPayments(orderId: number): Promise<number> {
  const released = await inTx(async (tx) => {
    await bankLock(tx);
    const o = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, number: true } });
    if (!o || o.status !== 'CANCELLED') return [];
    const txs = await tx.bankTransaction.findMany({ where: { orderId, status: { in: LINKED }, isDuplicate: false, refunded: false } });
    if (!txs.length) return [];
    await tx.bankTransaction.updateMany({ where: { id: { in: txs.map((t) => t.id) } }, data: { orderId: null, status: 'UNMATCHED', matchedAt: null, matchedByName: null } });
    await writeAudit(SYSTEM_ACTOR, 'bank.released_on_cancel', 'Order', String(orderId), { number: o.number, transactions: txs.map((t) => ({ id: t.id, amount: t.amount - t.excessRefunded, phone: t.phone })) }, tx, ['money', 'bank']);
    return txs;
  });
  // Тэр утсаар хүлээж буй шинэ захиалга байвал шууд тааруулна
  const phones = [...new Set(released.map((t) => t.phone).filter((x): x is string => !!x))];
  if (phones.length) {
    const pend = await db.order.findMany({ where: { status: 'PENDING_PAYMENT', OR: [{ phone: { in: phones } }, { extraPhone: { in: phones } }] }, select: { id: true }, orderBy: { id: 'asc' }, take: 20 });
    for (const p of pend) await matchOrderWithTransactions(p.id).catch((e) => console.error('[bank] release rematch', (e as Error).message));
  }
  return released.length;
}

/** Утсаар «Төлбөр хүлээж буй» захиалга хайж тааруулах (хуучин matchTransaction) */
async function autoMatch(tx: Tx, actor: Actor, txId: number, phones: string[]): Promise<'MATCHED' | 'PARTIAL' | null> {
  const t = await tx.bankTransaction.findUniqueOrThrow({ where: { id: txId } });
  if (t.isDuplicate || t.refunded) return null;
  for (const phone of phones) {
    const orders = await tx.order.findMany({ where: { status: 'PENDING_PAYMENT', OR: [{ phone }, { extraPhone: phone }] }, orderBy: { createdAt: 'asc' }, take: 5, select: { id: true, total: true } });
    for (const o of orders) {
      await lockOrder(tx, o.id);
      // Аудит #142: түгжихээс өмнө «Мөнгө орсон» / цуцлагдсан болсон бол дараагийн захиалгыг үзнэ
      const cur = await tx.order.findUnique({ where: { id: o.id }, select: { status: true } });
      if (cur?.status !== 'PENDING_PAYMENT') continue;
      const paid = (await paidFor(tx, o.id)) + t.amount - t.excessRefunded; // #148: буцаасан илүүг дахин тоолохгүй
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
      await bankLock(tx);
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
  const res = { imported: 0, matched: 0, partial: 0, duplicates: 0, errors: [] as string[], notProcessed: Math.max(0, list.length - 5000) };
  const rowsLog: { id: number; amount: number; phone: string | null; status: string; order?: number | null }[] = [];
  for (const raw of list.slice(0, 5000)) {
    try {
      await inTx(async (tx) => {
        // Нэг дор олон импорт зэрэг ажиллахад давхардал шалгалт зөрөхгүй
        await bankLock(tx);
        const description = String(raw.description ?? '').trim().slice(0, 500) || 'Хаан банк гүйлгээ';
        const amount = Math.round(Number(raw.amount));
        if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Дүн буруу');
        // Аудит А9: Gmail ч CSV шиг тайлбар дахь БҮХ утсыг шалгана (өмнө нь Gmail зөвхөн эхнийхийг)
        const phones = [...new Set([...(raw.phone ? [raw.phone] : []), ...extractPhones(description)])];
        const phone = phones[0] ?? null;
        if (raw.emailMessageId && (await tx.bankTransaction.findUnique({ where: { emailMessageId: raw.emailMessageId } }))) { res.duplicates++; return; }
        const day = ubDay(raw.date);
        // Gmail: имэйл бүр өөрийн дугаартай тул яг давхардлыг дугаараар нь (утгагүй ижил дүнтэй 2 өөр хүнийг давхардал гэхгүй).
        // Аудит #148: дугааргүй (гараар / туршилт) — ижил өдөр + дүн + утас (утга) байвал «Давхардсан» (хянана) — «өөр хүлээгдэж буй захиалга байна»
        // гэдгээр шинэ мөнгө гэж үзэхгүй (нэг мөнгө хоёр захиалгад орохгүй)
        const same = raw.emailMessageId ? [] : await tx.bankTransaction.findMany({
          where: { txDate: { gte: ubDayStart(day), lt: ubDayStart(addDays(day, 1)) }, amount, isDuplicate: false, ...(phone ? { phone } : { phone: null, description }) },
          select: { id: true }, take: 1,
        });
        const dup = same.length > 0;
        const t = await tx.bankTransaction.create({ data: {
          txDate: raw.date, description, amount, phone, source, emailMessageId: raw.emailMessageId ?? null, importedByName: actor.name,
          ...(dup ? { isDuplicate: true, status: 'DUPLICATE' } : {}),
        } });
        if (dup) { res.duplicates++; rowsLog.push({ id: t.id, amount, phone, status: 'DUPLICATE' }); return; }
        res.imported++;
        const m = phones.length ? await autoMatch(tx, actor, t.id, phones) : null;
        if (m === 'MATCHED') res.matched++; else if (m === 'PARTIAL') res.partial++;
        const after = await tx.bankTransaction.findUniqueOrThrow({ where: { id: t.id }, select: { status: true, orderId: true } });
        rowsLog.push({ id: t.id, amount, phone, status: after.status, order: after.orderId });
      });
    } catch (e) {
      res.errors.push(`${String(raw.description ?? '').slice(0, 40)}: ${(e as Error).message}`);
      if (res.errors.length > 50) break;
    }
  }
  if (res.imported || res.matched) bustCounts();
  // Аудит #148: орсон мөр бүр түүхэнд (дүн, утас, төлөв, захиалга)
  await writeAudit(actor, 'bank.imported', 'BankTransaction', source, { source, ...res, errors: res.errors.length, rows: rowsLog.slice(0, 500) } as unknown as Prisma.InputJsonValue, db, ['money', 'bank']);
  return res;
}

/** Шинэ «Төлбөр хүлээж буй» захиалга / дүн өөрчлөгдсөн үед: тухайн утасны таараагүй гүйлгээгээр тааруулах (хуучин matchPendingOrderWithTransactions) */
export async function matchOrderWithTransactions(orderId: number, by?: { actor: Actor; reason: string }) {
  return inTx(async (tx) => {
    await bankLock(tx);
    if (!(await lockOrder(tx, orderId))) return false;
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, status: true, total: true, phone: true, extraPhone: true } });
    if (o.status !== 'PENDING_PAYMENT') return false;
    let paid = await paidFor(tx, orderId);
    const who = by?.actor ?? SYSTEM_ACTOR;
    if (paid >= o.total) { await restatus(tx, orderId); return markPaidByBank(tx, who, orderId, paid, by ? `Банкны хуулга (${by.reason})` : 'Банкны хуулга (дүн өөрчлөгдсөн)'); }
    const phones = [o.phone, o.extraPhone].filter((x): x is string => !!x);
    // Аудит #148 (эзний шийдвэр): зөвхөн сүүлийн 24 цагийн таараагүй мөнгө (мөнгөө шилжүүлээд дараа нь захиалга үүсгэх хэвийн урсгал) —
    // хуучин мөнгийг утас солиод «авах»-аас сэргийлнэ; хуучныг нягтлан гараар, тайлбартайгаар тааруулна
    const free = await tx.bankTransaction.findMany({ where: { phone: { in: phones }, status: 'UNMATCHED', isDuplicate: false, refunded: false, txDate: { gte: new Date(Date.now() - AUTO_MATCH_WINDOW_MS) } }, orderBy: { txDate: 'asc' }, take: 20 });
    const used: { id: number; amount: number }[] = [];
    for (const t of free) {
      paid += t.amount - t.excessRefunded;
      used.push({ id: t.id, amount: t.amount - t.excessRefunded });
      await tx.bankTransaction.update({ where: { id: t.id }, data: { orderId, status: 'PARTIAL_PAYMENT', matchedAt: new Date(), matchedByName: by ? `Автомат (${by.reason}: ${by.actor.name})` : 'Автомат' } });
      if (paid >= o.total) break;
    }
    if (used.length && by) await writeAudit(by.actor, 'bank.auto_match_after_edit', 'Order', String(orderId), { reason: by.reason, transactions: used, phones } as unknown as Prisma.InputJsonValue, tx, ['money', 'bank']);
    await restatus(tx, orderId);
    if (paid >= o.total) return markPaidByBank(tx, who, orderId, paid, by ? `Банкны хуулга автомат таарсан (${by.reason})` : 'Банкны хуулга автомат таарсан');
    return false;
  });
}

/** «Гараар тааруулах»: захиалгын дугаараар (хуучин шиг; хуучин захиалгыг цуцалж шинээр үүсгэхгүй) */
export async function manualMatch(actor: UserActor, idIn: unknown, input: { orderNumber?: unknown; note?: unknown }) {
  assertEdit(actor);
  const id = Number(idIn);
  const number = String(input.orderNumber ?? '').trim();
  if (!/^\d{4,12}$/.test(number)) throw badRequest('Захиалгын дугаараа оруулна уу');
  const r = await inTx(async (tx) => {
    await bankLock(tx);
    const t = await tx.bankTransaction.findUnique({ where: { id } });
    if (!t) throw notFound('Гүйлгээ олдсонгүй');
    if (t.refunded) throw conflict('Буцаасан гүйлгээг тааруулахгүй', 'refunded');
    // Таарсан бол таарсан (#127, эзний шийдвэр): захиалгатай холбогдсон гүйлгээг өөр захиалгад шилжүүлэхгүй
    if (t.orderId) throw conflict('Захиалгатай таарсан гүйлгээг өөрчлөхгүй', 'already_matched');
    const o0 = await tx.order.findUnique({ where: { number }, select: { id: true } });
    if (!o0) throw notFound('Захиалга олдсонгүй');
    await lockOrder(tx, o0.id);
    const o = await tx.order.findUniqueOrThrow({ where: { id: o0.id }, select: { id: true, number: true, status: true, total: true, prepaid: true, phone: true, extraPhone: true } });
    // Аудит #142 (эзний шийдвэр): гүйлгээний утас захиалгынхаас өөр бол анхааруулж, шалтгаан бичүүлнэ (түүхэнд)
    const phoneDiff = !!t.phone && t.phone !== o.phone && t.phone !== o.extraPhone;
    const note = String(input.note ?? '').trim().slice(0, 300);
    // Аудит #148: «Давхардсан» гүйлгээг тааруулахад анхны гүйлгээг харуулж шалтгаан бичүүлнэ (нэг мөнгө хоёр захиалгад орохоос)
    let original: { id: number; orderNumber: string | null; status: string } | null = null;
    if (t.isDuplicate) {
      const d0 = ubDay(t.txDate);
      const orig = await tx.bankTransaction.findFirst({ where: { id: { not: t.id }, isDuplicate: false, amount: t.amount, txDate: { gte: ubDayStart(d0), lt: ubDayStart(addDays(d0, 1)) }, ...(t.phone ? { phone: t.phone } : { description: t.description }) }, orderBy: { id: 'asc' } });
      const on = orig?.orderId ? (await tx.order.findUnique({ where: { id: orig.orderId }, select: { number: true } }))?.number ?? null : null;
      original = orig ? { id: orig.id, orderNumber: on, status: orig.status } : null;
      if (note.replace(/\s/g, '').length < 5) throw conflict(`Энэ гүйлгээ «Давхардсан»${original ? ` — анхных нь #${original.id}${original.orderNumber ? ` (№${original.orderNumber}-д таарсан)` : ` (${BANK_STATUS_LABEL[original.status] ?? original.status})`}` : ''}. Үнэхээр өөр мөнгө бол шалтгаанаа бичнэ үү`, 'duplicate_note');
    }
    if (phoneDiff && note.replace(/\s/g, '').length < 5) throw conflict(`Гүйлгээний утас ${t.phone} нь №${o.number} захиалгын утас ${o.phone}-тэй таарахгүй байна — итгэлтэй бол шалтгаанаа бичнэ үү`, 'phone_mismatch');
    // Аудит Б8 (эзний шийдвэр): зөвхөн «Төлбөр хүлээж буй» — «Шинэ», хүргэсэн, цуцлагдсанд тааруулахгүй (буцаах арга байхгүй тул)
    if (o.status !== 'PENDING_PAYMENT') throw conflict(`№${o.number} «Төлбөр хүлээж буй» биш — зөвхөн төлбөр хүлээж буй захиалгад тааруулна`, 'not_pending');
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
    await writeAudit(actor, 'bank.manual_match', 'BankTransaction', String(id), { amount: t.amount, order: o.number, prevOrderId: prev, paid, total: o.total, paidMarked, ...(phoneDiff ? { phoneMismatch: { tx: t.phone, order: o.phone } } : {}), ...(t.isDuplicate ? { duplicateOf: original } : {}), ...(note ? { note } : {}) } as unknown as Prisma.InputJsonValue, tx, ['money', 'bank']);
    return { transaction: await tx.bankTransaction.findUniqueOrThrow({ where: { id } }), paid, total: o.total, paidMarked };
  });
  bustCounts();
  return r;
}

/**
 * «Илүүг буцаасан» (#129): захиалгын дүнгээс илүү орсон мөнгийг үйлчлүүлэгчид буцааж өгсөн — илүү дүн тэр гүйлгээнд бичигдэж,
 * төлсөн дүнгээс хасагдана → гүйлгээ «Таарсан». Эцсийн (болиулахгүй), түүхэнд.
 */
export async function refundExcess(actor: UserActor, idIn: unknown) {
  assertEdit(actor);
  const id = Number(idIn);
  const r = await inTx(async (tx) => {
    await bankLock(tx);
    const t = await tx.bankTransaction.findUnique({ where: { id } });
    if (!t) throw notFound('Гүйлгээ олдсонгүй');
    if (!t.orderId || t.status !== 'EXCESS_AMOUNT' || t.refunded || t.isDuplicate) throw conflict('Зөвхөн «Илүү» төлөлттэй гүйлгээнд', 'not_excess');
    await lockOrder(tx, t.orderId);
    const o = await tx.order.findUniqueOrThrow({ where: { id: t.orderId }, select: { id: true, number: true, total: true, paidAmount: true, prepaid: true, phone: true } });
    const excess = (await paidFor(tx, o.id)) - o.total;
    if (excess <= 0) throw conflict('Илүү төлөлт алга', 'not_excess');
    // Аудит Б7: илүү нь хэд хэдэн гүйлгээнд хуваагдсан бол сүүлийнхээс нь эхлэн хуваарилна (өмнө нь «excess_split» гэж зогсдог байв)
    const linked = await tx.bankTransaction.findMany({ where: { orderId: o.id, status: { in: LINKED }, isDuplicate: false, refunded: false }, orderBy: [{ id: 'asc' }] });
    const order = [t, ...linked.filter((x) => x.id !== t.id).reverse()];
    let left = excess;
    for (const x of order) {
      if (left <= 0) break;
      const can = Math.min(left, x.amount - x.excessRefunded);
      if (can <= 0) continue;
      await tx.bankTransaction.update({ where: { id: x.id }, data: { excessRefunded: { increment: can }, excessRefundedAt: new Date(), excessRefundedByName: actor.name } });
      left -= can;
    }
    if (left > 0) throw conflict('Илүү дүн гүйлгээнүүдээс их — нягтлан шалгана уу', 'excess_split');
    if (o.prepaid && o.paidAmount > o.total) await tx.order.update({ where: { id: o.id }, data: { paidAmount: o.total } });
    await restatus(tx, o.id);
    await writeAudit(actor, 'bank.excess_refunded', 'BankTransaction', String(id), { order: o.number, phone: o.phone, amount: excess, txAmount: t.amount, total: o.total }, tx, ['money', 'bank']);
    return { refunded: excess, order: o.number };
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
    await bankLock(tx);
    const t = await tx.bankTransaction.findUnique({ where: { id } });
    if (!t) throw notFound('Гүйлгээ олдсонгүй');
    if (t.refunded) return { ok: true };
    // Захиалгатай таарсан гүйлгээг «Буцаасан» болгохгүй (#127) — зөвхөн таараагүй / давхардсан мөнгийг буцаана
    if (t.orderId) throw conflict('Захиалгатай таарсан гүйлгээг «Буцаасан» болгохгүй', 'linked');
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
    // Аудит #148: бүтэн 8 оронтой утас — шууд индексээр; бусад нь trigram индекстэй утга / утас
    const or: Prisma.BankTransactionWhereInput[] = /^\d{8}$/.test(q) ? [{ phone: q }, { description: { contains: q } }] : [{ description: { contains: q, mode: 'insensitive' } }, { phone: { startsWith: q } }];
    if (/^\d+$/.test(q) && q.length <= 9) or.push({ amount: Number(q) });
    w.push({ OR: or });
  }
  if (f.from && isYmd(f.from)) w.push({ txDate: { gte: ubDayStart(f.from) } });
  if (f.to && isYmd(f.to)) w.push({ txDate: { lt: ubDayStart(addDays(f.to, 1)) } });
  return w.length ? { AND: w } : {};
}

/** Аудит #148: харах эрхтэй (оператор) таараагүй / давхардсан мөнгийн утас, утгыг харахгүй — бусдын мөнгийг «авах»-аас сэргийлнэ */
const maskFor = (canEdit: boolean) => <T extends { phone: string | null; description: string; orderId: number | null }>(t: T): T =>
  canEdit || t.orderId ? t : { ...t, phone: t.phone ? `${t.phone.slice(0, 2)}****${t.phone.slice(6)}` : null, description: '••• (нягтлан харна)' };

export async function listTransactions(actor: UserActor, f: BankFilter) {
  assertView(actor);
  const page = Math.max(1, Math.min(200, Math.floor(Number(f.page) || 1)));
  const edit = canBankImport(actor.roles);
  if (!edit && f.q) f = { ...f, q: undefined }; // харах эрхтэй хүн утсаар хайж олохгүй
  const w = where(f);
  const [items, total] = await Promise.all([
    db.bankTransaction.findMany({ where: w, orderBy: [{ txDate: 'desc' }, { id: 'desc' }], skip: (page - 1) * 50, take: 50 }),
    db.bankTransaction.count({ where: w }),
  ]);
  const orders = await db.order.findMany({ where: { id: { in: items.map((t) => t.orderId).filter((x): x is number => !!x) } }, select: { id: true, number: true, total: true, phone: true, status: true, prepaid: true, originalTotal: true } });
  const om = new Map(orders.map((o) => [o.id, o]));
  // «Илүү» гүйлгээний буцаах дүн (#129) = тэр захиалгын төлсөн − нийт дүн
  const exIds = [...new Set(items.filter((t) => t.status === 'EXCESS_AMOUNT' && t.orderId && !t.refunded).map((t) => t.orderId!))];
  const paid = exIds.length ? await db.$queryRaw<{ orderId: number; paid: number }[]>`
    SELECT "orderId", sum(amount - "excessRefunded")::int AS paid FROM "BankTransaction"
    WHERE "orderId" IN (${Prisma.join(exIds)}) AND "isDuplicate" = false AND refunded = false AND status IN ('MATCHED','EXCESS_AMOUNT','PARTIAL_PAYMENT') GROUP BY 1` : [];
  const pm = new Map(paid.map((x) => [x.orderId, x.paid]));
  // Аудит Б7: банкгүй (гараар «Мөнгө орсон» болгосон г.м.) илүү төлөлт — «Илүү» табд тайлбартай нь
  const manualExcess = f.tab === 'EXCESS_AMOUNT' && page === 1 ? await db.$queryRaw<{ id: number; number: string; phone: string; total: number; paidAmount: number; status: string; originalTotal: number | null }[]>`
    SELECT o.id, o.number, o.phone, o.total, o."paidAmount", o.status::text AS status, o."originalTotal" FROM "Order" o
    WHERE o.prepaid AND o."paidAmount" > o.total AND o.status <> 'CANCELLED'
      AND NOT EXISTS (SELECT 1 FROM "BankTransaction" t WHERE t."orderId" = o.id AND t.status = 'EXCESS_AMOUNT' AND NOT t.refunded AND NOT t."isDuplicate")
    ORDER BY o.id DESC LIMIT 200` : [];
  return {
    page, total, pages: Math.max(1, Math.ceil(total / 50)), canEdit: canBankImport(actor.roles),
    manualExcess: manualExcess.map((o) => ({ ...o, excess: o.paidAmount - o.total, why: excessWhy(o) })),
    items: items.map(maskFor(edit)).map((t) => ({ ...t, why: t.status === 'EXCESS_AMOUNT' && t.orderId ? excessWhy(om.get(t.orderId)) : null, statusLabel: t.refunded ? BANK_STATUS_LABEL.REFUNDED : t.isDuplicate ? BANK_STATUS_LABEL.DUPLICATE : BANK_STATUS_LABEL[t.status] ?? t.status, order: t.orderId ? om.get(t.orderId) ?? null : null,
      excess: t.status === 'EXCESS_AMOUNT' && t.orderId && !t.refunded ? Math.max(0, (pm.get(t.orderId) ?? 0) - (om.get(t.orderId)?.total ?? 0)) : 0 })),
  };
}

/** Илүү үүссэн шалтгааны тайлбар (Б7) */
function excessWhy(o: { status: string; total: number; originalTotal: number | null } | undefined): string {
  if (!o) return '';
  if (o.status === 'DELIVERED' && o.originalTotal !== null && o.originalTotal > o.total) return `Хэсэгчлэн хүргэсэн: ${o.originalTotal.toLocaleString('en-US')}₮ → ${o.total.toLocaleString('en-US')}₮ — үлдсэнийг үйлчлүүлэгчид буцаана`;
  return 'Төлсөн дүн захиалгын дүнгээс их (дүн буурсан эсвэл илүү шилжүүлсэн) — үйлчлүүлэгчид буцаана';
}

/** Банкгүй илүү төлөлт (гараар «Мөнгө орсон») — нягтлан буцааж өгсний дараа тэмдэглэнэ (Б7). Эцсийн. */
export async function refundManualExcess(actor: UserActor, orderIdIn: unknown) {
  assertEdit(actor);
  const id = Number(orderIdIn);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Захиалга олдсонгүй');
  const r = await inTx(async (tx) => {
    await bankLock(tx);
    if (!(await lockOrder(tx, id))) throw notFound('Захиалга олдсонгүй');
    const o = await tx.order.findUniqueOrThrow({ where: { id }, select: { id: true, number: true, phone: true, total: true, paidAmount: true, prepaid: true, status: true } });
    const excess = o.paidAmount - o.total;
    if (!o.prepaid || excess <= 0 || o.status === 'CANCELLED') throw conflict('Илүү төлөлт алга', 'not_excess');
    const bankEx = await tx.bankTransaction.count({ where: { orderId: id, status: 'EXCESS_AMOUNT', refunded: false, isDuplicate: false } });
    if (bankEx) throw conflict('Банкны гүйлгээтэй илүү — гүйлгээн дээрх «Илүүг буцаасан»-аар', 'bank_excess');
    await tx.order.update({ where: { id }, data: { paidAmount: o.total, version: { increment: 1 } } });
    await writeAudit(actor, 'order.excess_refunded', 'Order', String(id), { number: o.number, phone: o.phone, amount: excess, total: o.total }, tx, ['money', 'bank', 'order']);
    return { refunded: excess, order: o.number };
  });
  bustCounts();
  return r;
}

const statsCache = new Map<string, { at: number; v: unknown; ver: number }>();
export async function bankStats(actor: UserActor, f: { from?: string; to?: string }) {
  assertView(actor);
  // Аудит #148: 30 сек санах ой + хүнд ажлын хязгаар — олон хүн нээхэд бүх хүснэгтийг дахин дахин нийлүүлж бусдыг гацаахгүй
  const k = `${f.from ?? ''}|${f.to ?? ''}`;
  const c = statsCache.get(k);
  if (c && c.ver === bankVer && Date.now() - c.at < 30_000) return c.v as Awaited<ReturnType<typeof bankStatsRaw>>;
  const ver = bankVer;
  const v = await withHeavy(() => bankStatsRaw(f), { name: 'bank-stats', max: 2 });
  if (statsCache.size > 50) statsCache.clear();
  statsCache.set(k, { at: Date.now(), v, ver });
  return v;
}
async function bankStatsRaw(f: { from?: string; to?: string }) {
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

// Excel томьёо болж ажиллахаас сэргийлнэ (= + - @ эхэлсэн гүйлгээний утга) — аудит
const csvCell = (v: unknown) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export async function exportCsv(actor: UserActor, f: BankFilter) {
  assertEdit(actor); // Аудит #148: татаж авахыг зөвхөн засах эрхтэй (нягтлан г.м.)
  return withHeavy(() => exportRaw(f), { name: 'bank-export', max: 1 });
}
async function exportRaw(f: BankFilter) {
  const rows = await db.bankTransaction.findMany({ where: where(f), orderBy: { txDate: 'desc' }, take: 50_000 });
  const orders = await db.order.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.orderId).filter((x): x is number => !!x))] } }, select: { id: true, number: true, total: true } });
  const om = new Map(orders.map((o) => [o.id, o]));
  const head = ['Огноо', 'Утга', 'Дүн', 'Утас', 'Төлөв', 'Захиалга', 'Захиалгын дүн', 'Эх сурвалж'];
  const fmt = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
  const lines = rows.map((r) => [fmt(r.txDate), r.description, r.amount, r.phone ?? '', r.refunded ? 'Буцаасан' : r.isDuplicate ? 'Давхардсан' : BANK_STATUS_LABEL[r.status] ?? r.status, r.orderId ? om.get(r.orderId)?.number ?? '' : '', r.orderId ? om.get(r.orderId)?.total ?? '' : '', r.source].map(csvCell).join(','));
  return '﻿' + [head.join(','), ...lines].join('\n');
}

/** «Дүн өөрчлөгдсөн»: гүйлгээтэй холбогдсон захиалгын одоогийн дүн ≠ төлсөн нийлбэр (оператор дүнг сольсон гэх мэт) */
const pcCache = new Map<number, { at: number; v: unknown; ver: number }>();
export async function priceChanges(actor: UserActor, p: { page?: number }) {
  assertView(actor);
  const page = Math.max(1, Math.min(200, Math.floor(Number(p.page) || 1)));
  const c = pcCache.get(page);
  if (c && c.ver === bankVer && Date.now() - c.at < 30_000) return c.v as Awaited<ReturnType<typeof priceChangesRaw>>;
  const ver = bankVer;
  const v = await withHeavy(() => priceChangesRaw(page), { name: 'bank-price-changes', max: 1 });
  if (pcCache.size > 50) pcCache.clear();
  pcCache.set(page, { at: Date.now(), v, ver });
  return v;
}
async function priceChangesRaw(page: number) {
  const rows = await db.$queryRaw<{ id: number; number: string; phone: string; total: number; status: string; prepaid: boolean; paid: number; operatorName: string; updatedAt: Date; n: number }[]>`
    WITH s AS (SELECT "orderId", sum(amount - "excessRefunded")::int AS paid FROM "BankTransaction" WHERE "orderId" IS NOT NULL AND "isDuplicate" = false AND refunded = false AND status IN ('MATCHED','EXCESS_AMOUNT','PARTIAL_PAYMENT') GROUP BY 1)
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
    // Аудит Б8 (эзний шийдвэр): зөвхөн «Төлбөр хүлээж буй» захиалгад тааруулна
    where: { status: 'PENDING_PAYMENT', OR: [{ number: q }, { phone: q }, { extraPhone: q }] }, orderBy: { createdAt: 'desc' }, take: 20,
    select: { id: true, number: true, phone: true, total: true, status: true, prepaid: true, createdAt: true },
  });
  const paid = await db.bankTransaction.groupBy({ by: ['orderId'], where: { orderId: { in: items.map((i) => i.id) }, status: { in: LINKED }, isDuplicate: false, refunded: false }, _sum: { amount: true } });
  const pm = new Map(paid.map((p) => [p.orderId, p._sum.amount ?? 0]));
  return { items: items.map((i) => ({ ...i, paid: pm.get(i.id) ?? 0 })) };
}
