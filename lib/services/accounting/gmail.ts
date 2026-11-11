import type { Prisma } from '@prisma/client';
import { db } from '../../db';
import { badRequest, forbidden } from '../../errors';
import { writeAudit, SYSTEM_ACTOR, type Actor } from '../../audit';
import { canBankImport, canView } from '../../permissions';
import type { UserActor } from '../orders/core';
import { importTransactions, parseKhanMessage, type TxIn } from './bank';

/**
 * Gmail sync (хуучин шиг): Хаан банкны мэдэгдэл ирдэг Gmail-аас сүүлийн N хоногийн имэйлийг уншиж импортлоно.
 * Нэвтрэх эрх (OAuth): серверийн .env — GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (эзэн тохируулна; нууц үг кодонд хэзээ ч бичигдэхгүй).
 * Автомат: тохиргоо асаалттай бол арын ажил N минут тутам (хуучин IDLE/polling-ийн оронд — нэг л апп ажиллуулна).
 * Нэг имэйл нэг л удаа (emailMessageId давхардахгүй). Зөвхөн орлого.
 */
const KEY = 'bank.gmail';
export interface GmailSettings { sender: string; autoSync: boolean; minutes: number; days: number; lastSyncAt: string | null; lastResult: string | null }
const DEFAULTS: GmailSettings = { sender: '', autoSync: false, minutes: 5, days: 3, lastSyncAt: null, lastResult: null };

export const gmailConfigured = () => !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);

export async function readGmailSettings(): Promise<GmailSettings> {
  const s = await db.appSetting.findUnique({ where: { key: KEY } });
  return { ...DEFAULTS, ...((s?.value as object | null) ?? {}) };
}
async function saveSettings(v: GmailSettings, by?: string) {
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: v as unknown as Prisma.InputJsonValue, updatedById: by }, update: { value: v as unknown as Prisma.InputJsonValue, updatedById: by } });
}

export async function gmailStatus(actor: UserActor) {
  if (!canView(actor.roles, 'bank-import')) throw forbidden();
  return { configured: gmailConfigured(), settings: await readGmailSettings(), canEdit: canBankImport(actor.roles) };
}

export async function setGmailSettings(actor: UserActor, input: { sender?: unknown; autoSync?: unknown; minutes?: unknown; days?: unknown }) {
  if (!canBankImport(actor.roles)) throw forbidden();
  const cur = await readGmailSettings();
  const sender = String(input.sender ?? cur.sender).trim().slice(0, 120);
  if (sender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) throw badRequest('Илгээгчийн имэйл буруу');
  const minutes = Number(input.minutes ?? cur.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw badRequest('Давтамж 1–120 минут');
  const days = Number(input.days ?? cur.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw badRequest('Хоног 1–30');
  const v = { ...cur, sender, minutes, days, autoSync: input.autoSync === undefined ? cur.autoSync : input.autoSync === true };
  await saveSettings(v, actor.id);
  await writeAudit(actor, 'bank.gmail_settings', 'AppSetting', KEY, { sender, autoSync: v.autoSync, minutes, days }, db, ['settings', 'bank']);
  return v;
}

async function token(): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID!, client_secret: process.env.GMAIL_CLIENT_SECRET!, refresh_token: process.env.GMAIL_REFRESH_TOKEN!, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!r.ok || !j.access_token) throw badRequest(`Gmail нэвтрэлт амжилтгүй (${j.error ?? r.status}) — GMAIL_REFRESH_TOKEN-ийг шалгана уу`, 'gmail_auth');
  return j.access_token;
}

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[] }
const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function textOf(p: Part | undefined): string {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data) return b64(p.body.data);
  for (const c of p.parts ?? []) { const t = textOf(c); if (t) return t; }
  if (p.mimeType === 'text/html' && p.body?.data) return b64(p.body.data).replace(/<[^>]+>/g, ' ');
  return '';
}

/** Gmail-аас уншиж импортлох (гараар эсвэл арын ажил) */
export async function gmailSync(actor: Actor, opts: { days?: number } = {}) {
  if (!gmailConfigured()) throw badRequest('Gmail холбоогүй байна — серверт GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN тохируулна', 'gmail_not_configured');
  const s = await readGmailSettings();
  const days = Math.min(30, Math.max(1, opts.days ?? s.days));
  const at = await token();
  const q = [s.sender ? `from:${s.sender}` : '', `newer_than:${days}d`].filter(Boolean).join(' ');
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(20_000) });
  const lj = await list.json().catch(() => ({})) as { messages?: { id: string }[] };
  if (!list.ok) throw badRequest(`Gmail уншиж чадсангүй (${list.status})`, 'gmail_error');
  const ids = (lj.messages ?? []).map((m) => m.id);
  const known = new Set((await db.bankTransaction.findMany({ where: { emailMessageId: { in: ids } }, select: { emailMessageId: true } })).map((x) => x.emailMessageId));
  const txs: TxIn[] = [];
  let skipped = 0;
  for (const id of ids.filter((i) => !known.has(i))) {
    const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(20_000) });
    if (!m.ok) { skipped++; continue; }
    const mj = await m.json() as { internalDate?: string; snippet?: string; payload?: Part & { headers?: { name: string; value: string }[] } };
    const subject = mj.payload?.headers?.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
    const body = `${subject}\n${textOf(mj.payload) || mj.snippet || ''}`;
    const p = parseKhanMessage(body, new Date(Number(mj.internalDate ?? Date.now())));
    if (!p || !p.income) { skipped++; continue; }
    txs.push({ date: p.date, description: p.description, amount: p.amount, phone: p.phone, emailMessageId: id });
  }
  const r = txs.length ? await importTransactions(actor, txs, 'GMAIL') : { imported: 0, matched: 0, partial: 0, duplicates: 0, errors: [] as string[] };
  await saveSettings({ ...s, lastSyncAt: new Date().toISOString(), lastResult: `${ids.length} имэйл · ${r.imported} импорт · ${r.matched} таарсан · ${r.duplicates + known.size} давхардсан · ${skipped} алгассан` });
  return { ...r, emails: ids.length, alreadyImported: known.size, skipped };
}

/** Арын ажил: автомат sync (тохиргоогоор) */
export async function autoGmailSync() {
  if (!gmailConfigured()) return null;
  const s = await readGmailSettings();
  if (!s.autoSync) return null;
  if (s.lastSyncAt && Date.now() - Date.parse(s.lastSyncAt) < s.minutes * 60_000) return null;
  return gmailSync(SYSTEM_ACTOR).catch(async (e) => { await saveSettings({ ...s, lastSyncAt: new Date().toISOString(), lastResult: `Алдаа: ${(e as Error).message}` }); return null; });
}
