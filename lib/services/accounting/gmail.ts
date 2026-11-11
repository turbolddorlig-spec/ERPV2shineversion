import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden } from '../../errors';
import { writeAudit, SYSTEM_ACTOR, type Actor } from '../../audit';
import { canBankImport, canEdit, canView } from '../../permissions';
import type { UserActor } from '../orders/core';
import { importTransactions, parseKhanMessages, type TxIn } from './bank';

/**
 * Gmail холболт (хуучин ERP шиг IMAP + «App Password»): Тохиргоо хуудсанд Gmail хаяг + 16 оронтой App Password бичээд «Sync» —
 * Хаан банкны мэдэгдлийн имэйлийг (сүүлийн N хоног) уншиж импортлоно. Автомат: N минут тутам (арын ажил).
 * Нууц үг database-д ШИФРЛЭГДЭЖ хадгалагдана (AES-256-GCM, түлхүүр нь серверийн орчноос — database-д байхгүй), API хариунд хэзээ ч гарахгүй.
 * Нэг имэйл нэг л удаа (emailMessageId давхардахгүй). Зөвхөн орлого.
 */
const KEY = 'bank.gmail';
export interface GmailSettings {
  email: string; passwordEnc: string | null; sender: string; autoSync: boolean; minutes: number; days: number;
  lastSyncAt: string | null; lastResult: string | null; lastOk: boolean | null;
}
const DEFAULTS: GmailSettings = { email: '', passwordEnc: null, sender: '', autoSync: true, minutes: 5, days: 3, lastSyncAt: null, lastResult: null, lastOk: null };

// ───────── нууц үг шифрлэх ─────────
const secretKey = () => createHash('sha256').update(`zahialga-gmail|${process.env.APP_SECRET ?? process.env.DATABASE_URL ?? ''}`).digest();
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decrypt(s: string): string | null {
  try {
    const [v, iv, tag, data] = s.split(':');
    if (v !== 'v1' || !iv || !tag || !data) return null;
    const d = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

export async function readGmailSettings(): Promise<GmailSettings> {
  const s = await db.appSetting.findUnique({ where: { key: KEY } });
  return { ...DEFAULTS, ...((s?.value as object | null) ?? {}) };
}
async function saveSettings(v: GmailSettings, by?: string | null) {
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: v as unknown as Prisma.InputJsonValue, updatedById: by ?? null }, update: { value: v as unknown as Prisma.InputJsonValue, updatedById: by ?? null } });
}
export const isConfigured = (s: GmailSettings) => !!(s.email && s.passwordEnc);
/** API-д гаргах (нууц үггүй) */
const publicView = (s: GmailSettings) => ({ email: s.email, hasPassword: !!s.passwordEnc, sender: s.sender, autoSync: s.autoSync, minutes: s.minutes, days: s.days, lastSyncAt: s.lastSyncAt, lastResult: s.lastResult, lastOk: s.lastOk });
const canSet = (a: UserActor) => canEdit(a.roles, 'settings') || canBankImport(a.roles);

export async function gmailStatus(actor: UserActor) {
  if (!canView(actor.roles, 'bank-import') && !canEdit(actor.roles, 'settings')) throw forbidden();
  const s = await readGmailSettings();
  return { configured: isConfigured(s), settings: publicView(s), canEdit: canSet(actor) };
}

/** Gmail хаяг, App Password (хоосон бол хуучнаараа), илгээгч, автомат, давтамж */
export async function setGmailSettings(actor: UserActor, input: { email?: unknown; appPassword?: unknown; sender?: unknown; autoSync?: unknown; minutes?: unknown; days?: unknown; disconnect?: unknown }) {
  if (!canSet(actor)) throw forbidden();
  const cur = await readGmailSettings();
  if (input.disconnect === true) {
    const v = { ...cur, passwordEnc: null, autoSync: false, lastResult: 'Салгасан', lastOk: null };
    await saveSettings(v, actor.id);
    await writeAudit(actor, 'bank.gmail_disconnected', 'AppSetting', KEY, { email: cur.email }, db, ['settings', 'bank']);
    return publicView(v);
  }
  const email = String(input.email ?? cur.email).trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Gmail хаягаа зөв бичнэ үү', 'bad_email');
  const rawPw = String(input.appPassword ?? '').replace(/\s+/g, '');
  if (rawPw && !/^[a-zA-Z]{16}$/.test(rawPw)) throw badRequest('App Password нь 16 үсэг байна (зайтай бичсэн ч болно). Энгийн Gmail нууц үг биш', 'bad_app_password');
  if (!rawPw && !cur.passwordEnc) throw badRequest('16 оронтой App Password-оо бичнэ үү', 'bad_app_password');
  const sender = String(input.sender ?? cur.sender).trim().slice(0, 120);
  if (sender && !/^[^\s@]*@?[^\s@]+$/.test(sender)) throw badRequest('Илгээгчийн имэйл буруу');
  const minutes = Number(input.minutes ?? cur.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw badRequest('Давтамж 1–120 минут');
  const days = Number(input.days ?? cur.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw badRequest('Хоног 1–30');
  const v: GmailSettings = {
    ...cur, email, sender, minutes, days, autoSync: input.autoSync === undefined ? cur.autoSync : input.autoSync === true,
    ...(rawPw ? { passwordEnc: encrypt(rawPw.toLowerCase()), lastOk: null, lastResult: null } : {}),
  };
  await saveSettings(v, actor.id);
  await writeAudit(actor, 'bank.gmail_settings', 'AppSetting', KEY, { email, sender, autoSync: v.autoSync, minutes, days, passwordChanged: !!rawPw }, db, ['settings', 'bank']);
  return publicView(v);
}

// ───────── IMAP уншилт ─────────

export interface MailItem { id: string; date: Date; text: string }
/** Тест/орлуулах боломжтой: IMAP-аас имэйл унших */
export type MailFetcher = (o: { email: string; password: string; sender: string; days: number }) => Promise<MailItem[]>;

const imapFetch: MailFetcher = async ({ email, password, sender, days }) => {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass: password }, logger: false, socketTimeout: 60_000, greetingTimeout: 20_000, connectionTimeout: 20_000 });
  try {
    await client.connect();
  } catch (e) {
    const err = e as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string };
    if (err.authenticationFailed || /auth|credentials|invalid/i.test(err.responseText ?? err.message ?? '')) throw badRequest('Gmail нэвтэрч чадсангүй — Gmail хаяг, 16 оронтой App Password-оо шалгана уу (Google бүртгэлд 2 шаттай баталгаажуулалт асаалттай байх ёстой)', 'gmail_auth');
    throw badRequest(`Gmail-тай холбогдож чадсангүй (${err.code ?? err.message ?? 'сүлжээ'}) — серверийн интернэтийг шалгана уу`, 'gmail_network');
  }
  const out: MailItem[] = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - days * 86_400_000);
      // Зөвхөн «Khan Bank» гэсэн имэйл (бусдыг огт уншихгүй)
      const found = await client.search({ since, body: 'Khan Bank', ...(sender ? { from: sender } : {}) }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice(-300);
      if (uids.length) {
        for await (const m of client.fetch(uids, { uid: true, source: true, envelope: true, internalDate: true }, { uid: true })) {
          if (!m.source) continue;
          const p = await simpleParser(m.source);
          const text = `${p.subject ?? ''}\n${p.text ?? (typeof p.html === 'string' ? p.html.replace(/<[^>]+>/g, ' ') : '')}`;
          const when = m.internalDate instanceof Date ? m.internalDate : p.date ?? new Date();
          out.push({ id: `gmail:${email}:${m.envelope?.messageId ?? p.messageId ?? m.uid}`.slice(0, 300), date: when, text });
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => undefined); }
  return out;
};
let fetcher: MailFetcher = imapFetch;
/** Зөвхөн тестэд */
export function _setMailFetcher(f: MailFetcher | null) { fetcher = f ?? imapFetch; }

/** «Sync»: Gmail-аас уншиж импортлох (гараар эсвэл арын ажил) */
export async function gmailSync(actor: Actor, opts: { days?: number } = {}) {
  const s = await readGmailSettings();
  if (!isConfigured(s)) throw badRequest('Gmail холбоогүй байна — Тохиргоо → Gmail хэсэгт хаяг, 16 оронтой App Password-оо бичнэ үү', 'gmail_not_configured');
  const password = decrypt(s.passwordEnc!);
  if (!password) throw badRequest('Хадгалсан App Password-ыг уншиж чадсангүй — Тохиргоо хэсэгт дахин бичнэ үү', 'gmail_password_lost');
  const days = Math.min(30, Math.max(1, opts.days ?? s.days));
  try {
    const mails = await fetcher({ email: s.email, password, sender: s.sender, days });
    const txs: TxIn[] = [];
    let skipped = 0;
    for (const m of mails) {
      // Нэг имэйлд олон мессеж байж болно — мессеж бүр өөрийн дугаартай (давхардахгүй)
      const ps = parseKhanMessages(m.text, m.date);
      if (!ps.length) { skipped++; continue; }
      ps.forEach((p, i) => {
        const id = ps.length > 1 ? `${m.id}#${i}` : m.id;
        if (!p.income) { skipped++; return; }
        txs.push({ date: p.date, description: p.description, amount: p.amount, phone: p.phone, emailMessageId: id });
      });
    }
    const knownTx = new Set((await db.bankTransaction.findMany({ where: { emailMessageId: { in: txs.map((t) => t.emailMessageId!) } }, select: { emailMessageId: true } })).map((x) => x.emailMessageId));
    const fresh = txs.filter((t) => !knownTx.has(t.emailMessageId!));
    const already = txs.length - fresh.length;
    const r = fresh.length ? await importTransactions(actor, fresh, 'GMAIL') : { imported: 0, matched: 0, partial: 0, duplicates: 0, errors: [] as string[] };
    const res = { ...r, emails: mails.length, alreadyImported: already, skipped };
    await saveSettings({ ...(await readGmailSettings()), lastSyncAt: new Date().toISOString(), lastOk: true, lastResult: `${mails.length} имэйл · ${r.imported} шинэ гүйлгээ · ${r.matched} таарсан · ${already + r.duplicates} өмнө орсон · ${skipped} зарлага/бусад` });
    return res;
  } catch (e) {
    await saveSettings({ ...(await readGmailSettings()), lastSyncAt: new Date().toISOString(), lastOk: false, lastResult: `Алдаа: ${(e as Error).message}` });
    throw e;
  }
}

/** Арын ажил: автомат sync (тохиргоогоор) */
export async function autoGmailSync() {
  const s = await readGmailSettings();
  if (!isConfigured(s) || !s.autoSync) return null;
  if (s.lastSyncAt && Date.now() - Date.parse(s.lastSyncAt) < s.minutes * 60_000) return null;
  return gmailSync(SYSTEM_ACTOR).catch(() => null);
}

/**
 * Gmail-аас буруу импортлогдсон гүйлгээг цэвэрлэх (задлагч сайжрахаас өмнө Хаан банкны биш имэйл орсон, #89):
 * Gmail-аас орсон, захиалгад ХОЛБОГДООГҮЙ, буцаагаагүй гүйлгээг устгаад дахин Sync — жинхэнэ Хаан банкны мессеж шинэ задлагчаар дахин орно.
 * Захиалгад холбогдсон (таарсан) гүйлгээнд хүрэхгүй — тэдгээрийг «Таарсан» табаас шалгана.
 */
export async function cleanupGmailImports(actor: UserActor) {
  if (!canEdit(actor.roles, 'settings')) throw forbidden('Цэвэрлэгээг админ хийнэ');
  const where = { source: 'GMAIL', orderId: null, refunded: false };
  const n = await db.bankTransaction.count({ where });
  const linked = await db.bankTransaction.count({ where: { source: 'GMAIL', orderId: { not: null } } });
  await db.bankTransaction.deleteMany({ where });
  await writeAudit(actor, 'bank.gmail_cleanup', 'BankTransaction', 'GMAIL', { deleted: n, linkedKept: linked }, db, ['money', 'bank']);
  let resync: Awaited<ReturnType<typeof gmailSync>> | null = null;
  let resyncError: string | null = null;
  try { resync = await gmailSync(actor); } catch (e) { resyncError = (e as Error).message; }
  return { deleted: n, linkedKept: linked, resync, resyncError };
}
