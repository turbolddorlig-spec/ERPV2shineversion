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
const secretKey = () => createHash('sha256').update(`zahialga-gmail|${process.env.APP_SECRET || process.env.DATABASE_URL || ''}`).digest();
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
/** Аудит #148 (эзний шийдвэр): илгээгчийн Gmail (банкны яг хаяг) заавал — үгүй бол татахгүй */
export const isConfigured = (s: GmailSettings) => !!(s.email && s.passwordEnc && SENDER_RE.test(s.sender));
const SENDER_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/** API-д гаргах (нууц үггүй) */
const publicView = (s: GmailSettings) => ({ email: s.email, hasPassword: !!s.passwordEnc, sender: s.sender, autoSync: s.autoSync, minutes: s.minutes, days: s.days, lastSyncAt: s.lastSyncAt, lastResult: s.lastResult, lastOk: s.lastOk });
// Аудит #148: Gmail-ийн тохиргоог (хаяг, нууц үг, илгээгч) зөвхөн Супер админ, Админ — өөр шуудан руу чиглүүлэхээс сэргийлнэ
const canSet = (a: UserActor) => canEdit(a.roles, 'settings');

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
  const sender = String(input.sender ?? cur.sender).trim().toLowerCase().slice(0, 120);
  if (!SENDER_RE.test(sender)) throw badRequest('Илгээгчийн Gmail (банкны мэдэгдэл ирдэг яг хаяг, жишээ: info@khanbank.com) заавал бичнэ үү', 'sender_required');
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

export interface MailItem { id: string; date: Date; text: string; from: string; authOk: boolean }
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
          // Аудит #148: илгээгчийн ЯГ хаяг (нэр биш) ба Gmail-ийн баталгаажуулалт (DKIM / SPF — тухайн домэйн)
          const from = (p.from?.value?.[0]?.address ?? '').toLowerCase();
          const ar = [p.headers.get('authentication-results')].flat().filter(Boolean).map(String).join(' ').toLowerCase();
          out.push({ id: `gmail:${email}:${m.envelope?.messageId ?? p.messageId ?? m.uid}`.slice(0, 300), date: when, text, from, authOk: authPass(ar, sender) });
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => undefined); }
  return out;
};
/** Gmail-ийн «Authentication-Results»: илгээгчийн домэйнээр DKIM эсвэл SPF pass (хуурамч «From»-ыг Gmail өөрөө тэмдэглэнэ) */
export function authPass(ar: string, sender: string): boolean {
  const dom = sender.split('@')[1]?.toLowerCase() ?? '';
  if (!dom || !ar) return false;
  const esc = dom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dkim = new RegExp(`dkim=pass[^;]*header\\.(?:i|d)=@?(?:[a-z0-9-]+\\.)*${esc}\\b`).test(ar);
  const spf = new RegExp(`spf=pass[^;]*smtp\\.mailfrom=[^;\\s]*@?(?:[a-z0-9-]+\\.)*${esc}\\b`).test(ar);
  const dmarcFail = /dmarc=fail/.test(ar);
  return (dkim || spf) && !dmarcFail;
}
let fetcher: MailFetcher = imapFetch;
/** Зөвхөн тестэд */
export function _setMailFetcher(f: MailFetcher | null) { fetcher = f ?? imapFetch; }

/** «Sync»: Gmail-аас уншиж импортлох (гараар эсвэл арын ажил). Аудит #148: нэг зэрэг нэг л sync */
let running: Promise<unknown> | null = null;
export async function gmailSync(actor: Actor, opts: { days?: number } = {}): Promise<Awaited<ReturnType<typeof gmailSyncRaw>>> {
  while (running) await running.catch(() => undefined);
  const p = gmailSyncRaw(actor, opts);
  running = p;
  try { return await p; } finally { if (running === p) running = null; }
}
async function gmailSyncRaw(actor: Actor, opts: { days?: number } = {}) {
  const s = await readGmailSettings();
  if (!isConfigured(s)) throw badRequest('Gmail холбоогүй байна — Тохиргоо → Gmail хэсэгт хаяг, 16 оронтой App Password, илгээгчийн Gmail-ээ бичнэ үү', 'gmail_not_configured');
  const password = decrypt(s.passwordEnc!);
  if (!password) throw badRequest('Хадгалсан App Password-ыг уншиж чадсангүй — Тохиргоо хэсэгт дахин бичнэ үү', 'gmail_password_lost');
  const days = Math.min(30, Math.max(1, opts.days ?? s.days));
  try {
    const mails = await fetcher({ email: s.email, password, sender: s.sender, days });
    const txs: TxIn[] = [];
    let skipped = 0; let rejected = 0;
    const rejectedLog: { id: string; from: string }[] = [];
    for (const m of mails) {
      // Аудит #148: зөвхөн тохируулсан илгээгчээс, Gmail баталгаажуулсан имэйл — бусдыг (хуурамч) хүлээж авахгүй
      if (m.from !== s.sender.toLowerCase() || !m.authOk) { rejected++; rejectedLog.push({ id: m.id.slice(0, 120), from: m.from }); continue; }
      // Нэг имэйл = нэг гүйлгээ
      const ps = parseKhanMessages(m.text, m.date);
      if (!ps.length) { skipped++; continue; }
      const p = ps[0]!;
      if (!p.income) { skipped++; continue; }
      txs.push({ date: p.date, description: p.description, amount: p.amount, phone: p.phone, emailMessageId: m.id });
    }
    if (rejected) await writeAudit(actor, 'bank.gmail_rejected', 'AppSetting', KEY, { rejected, sample: rejectedLog.slice(0, 20) } as unknown as Prisma.InputJsonValue, db, ['money', 'bank', 'security']);
    const knownTx = new Set((await db.bankTransaction.findMany({ where: { emailMessageId: { in: txs.map((t) => t.emailMessageId!) } }, select: { emailMessageId: true } })).map((x) => x.emailMessageId));
    const fresh = txs.filter((t) => !knownTx.has(t.emailMessageId!));
    const already = txs.length - fresh.length;
    const r = fresh.length ? await importTransactions(actor, fresh, 'GMAIL') : { imported: 0, matched: 0, partial: 0, duplicates: 0, errors: [] as string[] };
    const res = { ...r, emails: mails.length, alreadyImported: already, skipped, rejected };
    await saveSettings({ ...(await readGmailSettings()), lastSyncAt: new Date().toISOString(), lastOk: true, lastResult: `${mails.length} имэйл · ${r.imported} шинэ гүйлгээ · ${r.matched} таарсан · ${already + r.duplicates} өмнө орсон · ${skipped} зарлага/бусад${rejected ? ` · ⚠ ${rejected} баталгаажаагүй илгээгч (хүлээж аваагүй)` : ''}` });
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
 * Аудит #148 (эзний шийдвэр): мөнгөний бичлэгийг ХЭЗЭЭ Ч устгахгүй — «Дахин шалгах» нь зөвхөн Gmail-аас дахин уншиж,
 * өмнө орсоныг (имэйлийн дугаараар) алгасаад шинийг нэмнэ.
 */
export async function cleanupGmailImports(actor: UserActor) {
  if (!canEdit(actor.roles, 'settings')) throw forbidden('Дахин шалгахыг админ хийнэ');
  await writeAudit(actor, 'bank.gmail_resync', 'BankTransaction', 'GMAIL', {}, db, ['money', 'bank']);
  let resync: Awaited<ReturnType<typeof gmailSync>> | null = null;
  let resyncError: string | null = null;
  try { resync = await gmailSync(actor); } catch (e) { resyncError = (e as Error).message; }
  return { deleted: 0, linkedKept: 0, resync, resyncError };
}
