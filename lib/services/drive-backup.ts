import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { badRequest, forbidden } from '../errors';
import { writeAudit } from '../audit';
import { decrypt, encrypt } from '../secret';
import type { UserActor } from './users';
import { readBackupStatus, _bustBackupCache } from './backup-status';

/**
 * #171 Нөөц хуулбарыг Google Drive-д Тохиргооноос холбох (эзний шийдвэр 2026-11-18; ./setup-drive-backup.sh-ийг орлоно).
 * - Супер админ Google Cloud-ын OAuth Client ID/Secret-ийг нэг удаа оруулна (компани бүр өөрийн).
 * - «Google Drive холбох» → Google зөвшөөрөл → буцах хаяг → refresh token шифрлэгдэж database-д;
 *   backup контейнер уншдаг rclone.conf-ийг /app/data/drive-д бичнэ (backup-д зөвхөн унших).
 * - scope: drive.file (зөвхөн энэ програмын үүсгэсэн файл — таны бусад Drive файлд хүрэхгүй) + имэйл.
 * - «Өөр Drive холбох» = дахин зөвшөөрөл (өөр бүртгэлээр); «Салгах» = токен цуцалж, файл устгана.
 * - «Одоо хуулбар авах» — backup контейнер минут тутам шалгадаг тэмдэг файл.
 * - Захиалга, мөнгө, үлдэгдэлд хамааралгүй.
 */
const KEY = 'driveBackup';
const STATE_KEY = 'driveOauthState';
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = () => process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const USERINFO = () => process.env.GOOGLE_USERINFO_URL ?? 'https://openidconnect.googleapis.com/v1/userinfo';
const REVOKE = () => process.env.GOOGLE_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke';
const ABOUT = () => process.env.GOOGLE_DRIVE_ABOUT_URL ?? 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota';
export const confDir = () => process.env.DRIVE_CONF_DIR ?? path.join(process.cwd(), 'data', 'drive');

interface Stored { clientId?: string; clientSecret?: string; refreshToken?: string; email?: string; connectedAt?: string; connectedBy?: string }
const dec = (v?: string) => (v ? (v.startsWith('v1:') ? decrypt(v) ?? '' : v) : '');
const isSA = (a: UserActor) => a.roles.includes('SUPER_ADMIN');
async function read(): Promise<Stored> {
  const r = await db.appSetting.findUnique({ where: { key: KEY } });
  return r && typeof r.value === 'object' && r.value ? (r.value as Stored) : {};
}
async function save(actor: UserActor, next: Stored, action: string, details: Record<string, unknown>) {
  await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: next as Prisma.InputJsonValue, updatedById: actor.id }, update: { value: next as Prisma.InputJsonValue, updatedById: actor.id } });
    // Нууц (secret, token) түүхэнд хэзээ ч бичигдэхгүй
    await writeAudit(actor, action, 'AppSetting', KEY, details as Prisma.InputJsonValue, tx, ['settings', 'backup']);
  });
}

/** Буцах хаяг — Google Cloud-д яг ийм бүртгэнэ (APP_URL .env-ээс) */
export function redirectUri(fallbackOrigin: string): string {
  const base = (process.env.APP_URL || fallbackOrigin).replace(/\/$/, '');
  return `${base}/api/settings/drive/callback`;
}

async function confExists() { try { await stat(path.join(confDir(), 'rclone.conf')); return true; } catch { return false; } }

export async function getDriveSettings(actor: UserActor, origin: string) {
  if (!isSA(actor)) throw forbidden();
  const s = await read();
  const st = await readBackupStatus();
  return {
    clientId: s.clientId ?? '', secretSet: !!s.clientSecret, connected: !!s.refreshToken, email: s.email ?? null, connectedAt: s.connectedAt ?? null, connectedBy: s.connectedBy ?? null,
    redirectUri: redirectUri(origin), confWritten: await confExists(),
    status: st ? { lastOk: st.lastOk || null, driveOkAt: st.driveOkAt || null, driveErrorAt: st.driveErrorAt || null, driveError: st.driveError || null, driveUsedPct: st.driveUsedPct || null, driveConfigured: st.driveConfigured } : null,
  };
}

export async function saveDriveClient(actor: UserActor, input: { clientId?: unknown; clientSecret?: unknown }) {
  if (!isSA(actor)) throw forbidden('Зөвхөн Супер админ');
  const cur = await read();
  const next: Stored = { ...cur };
  const changed: string[] = [];
  if (input.clientId !== undefined) {
    const id = String(input.clientId ?? '').trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw badRequest('Client ID буруу — «….apps.googleusercontent.com» гэж төгссөн байна');
    if (id !== cur.clientId) { next.clientId = id; changed.push('clientId'); }
  }
  if (input.clientSecret !== undefined && String(input.clientSecret).trim()) {
    const sec = String(input.clientSecret).trim();
    if (sec.length < 10 || sec.length > 200 || /[\s/{}"'<>]/.test(sec) || /^https?:/i.test(sec)) throw badRequest('Client Secret буруу');
    next.clientSecret = encrypt(sec); changed.push('clientSecret');
  }
  if (!changed.length) return;
  await save(actor, next, 'settings.drive_client', { changed, clientId: next.clientId ?? null });
}

/** «Google Drive холбох» — Google-ийн зөвшөөрлийн хаяг */
export async function driveAuthUrl(actor: UserActor, origin: string): Promise<string> {
  if (!isSA(actor)) throw forbidden();
  const s = await read();
  if (!s.clientId || !s.clientSecret) throw badRequest('Эхлээд Client ID, Client Secret оруулж хадгална уу');
  const state = randomBytes(24).toString('hex');
  await db.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value: { state, at: Date.now(), by: actor.id } }, update: { value: { state, at: Date.now(), by: actor.id } } });
  const q = new URLSearchParams({
    client_id: s.clientId, redirect_uri: redirectUri(origin), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
  });
  return `${AUTH}?${q.toString()}`;
}

async function postForm(url: string, body: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(15_000) });
  const txt = await res.text();
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(txt); } catch { /* */ }
  return { ok: res.ok, status: res.status, j, txt };
}

/** rclone.conf — backup контейнер үүнийг уншина (токен шинэчлэлийг rclone өөрөө хийнэ) */
async function writeConf(clientId: string, clientSecret: string, refreshToken: string, accessToken: string, expiresIn: number) {
  const token = JSON.stringify({ access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expiry: new Date(Date.now() + expiresIn * 1000).toISOString() });
  const body = `[gdrive]\ntype = drive\nscope = drive.file\nclient_id = ${clientId}\nclient_secret = ${clientSecret}\ntoken = ${token}\n`;
  const dir = confDir();
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.rclone.conf.${process.pid}`);
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, path.join(dir, 'rclone.conf'));
}

/** Google буцаасны дараа: код → токен; имэйл; хадгалах; rclone.conf */
export async function driveCallback(actor: UserActor, input: { code?: string | null; state?: string | null; error?: string | null }, origin: string): Promise<{ email: string }> {
  if (!isSA(actor)) throw forbidden();
  if (input.error) throw badRequest(input.error === 'access_denied' ? 'Зөвшөөрөл өгөөгүй' : `Google: ${input.error}`);
  const st = await db.appSetting.findUnique({ where: { key: STATE_KEY } });
  const v = (st?.value ?? {}) as { state?: string; at?: number };
  await db.appSetting.deleteMany({ where: { key: STATE_KEY } });
  if (!input.state || !v.state || v.state !== input.state || Date.now() - (v.at ?? 0) > 15 * 60_000) throw badRequest('Холболтын хугацаа дууссан — «Google Drive холбох»-ыг дахин дарна уу');
  if (!input.code) throw badRequest('Google код ирсэнгүй');
  const s = await read();
  const secret = dec(s.clientSecret);
  if (!s.clientId || !secret) throw badRequest('Client ID / Secret алга');
  const t = await postForm(TOKEN(), { code: input.code, client_id: s.clientId, client_secret: secret, redirect_uri: redirectUri(origin), grant_type: 'authorization_code' });
  if (!t.ok) throw badRequest(`Google токен өгсөнгүй: ${String(t.j.error_description ?? t.j.error ?? t.status)}`);
  const refresh = String(t.j.refresh_token ?? '');
  const access = String(t.j.access_token ?? '');
  // Google-ийн зөвшөөрлийн цонхонд эрх бүр тусдаа чагттай — Drive-ийн чагтыг тэмдэглээгүй бол холбогдсон мэт боловч бичиж чадахгүй (insufficientPermissions)
  const granted = String(t.j.scope ?? '');
  if (granted && !granted.split(/\s+/).includes('https://www.googleapis.com/auth/drive.file')) {
    if (refresh) await postForm(REVOKE(), { token: refresh }).catch(() => null);
    throw badRequest('Google Drive-ийн эрх өгөгдөөгүй байна — дахин «Google Drive холбох» дараад зөвшөөрлийн цонхонд «Google Drive-д…» гэсэн чагтыг заавал тэмдэглээд Continue дарна уу', 'drive_scope_missing');
  }
  if (!refresh) throw badRequest('Google «refresh token» өгсөнгүй — myaccount.google.com/permissions-оос энэ програмын эрхийг устгаад дахин холбоно уу');
  let email = '';
  try {
    const u = await fetch(USERINFO(), { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000) });
    email = String(((await u.json()) as { email?: string }).email ?? '');
  } catch { /* имэйлгүй ч холбогдоно */ }
  // Өмнөх бүртгэлийн токеныг цуцална — ЗӨВХӨН өөр Google бүртгэл рүү шилжихэд.
  // #180: ижил бүртгэлийг дахин холбоход Google нэг зөвшөөрлийн БҮХ токеныг (шинийг ч) цуцалдаг тул цуцлахгүй (401 алдаа гардаг байв).
  const old = dec(s.refreshToken);
  const sameAccount = !!email && !!s.email && email.toLowerCase() === s.email.toLowerCase();
  if (old && old !== refresh && !sameAccount) await postForm(REVOKE(), { token: old }).catch(() => null);
  await writeConf(s.clientId, secret, refresh, access, Number(t.j.expires_in ?? 3600));
  const prevEmail = s.email ?? null;
  await save(actor, { ...s, refreshToken: encrypt(refresh), email, connectedAt: new Date().toISOString(), connectedBy: actor.name }, 'settings.drive_connected', { email, previous: prevEmail });
  _bustBackupCache();
  return { email };
}

export async function disconnectDrive(actor: UserActor) {
  if (!isSA(actor)) throw forbidden();
  const s = await read();
  const tok = dec(s.refreshToken);
  if (tok) await postForm(REVOKE(), { token: tok }).catch(() => null);
  await rm(path.join(confDir(), 'rclone.conf'), { force: true });
  const { refreshToken: _r, email: _e, connectedAt: _c, connectedBy: _b, ...rest } = s;
  void _r; void _e; void _c; void _b;
  await save(actor, rest, 'settings.drive_disconnected', { email: s.email ?? null });
  _bustBackupCache();
}

/** Холболтыг шалгах — Drive-ийн бүртгэл, сул зай (rclone-гүйгээр, шууд Google-ээс) */
export async function testDrive(actor: UserActor) {
  if (!isSA(actor)) throw forbidden();
  const s = await read();
  const tok = dec(s.refreshToken); const secret = dec(s.clientSecret);
  if (!tok || !s.clientId || !secret) throw badRequest('Google Drive холбогдоогүй байна');
  const t = await postForm(TOKEN(), { client_id: s.clientId, client_secret: secret, refresh_token: tok, grant_type: 'refresh_token' });
  if (!t.ok) return { ok: false, info: `Токен хүчингүй: ${String(t.j.error_description ?? t.j.error ?? t.status)} — «Өөр Drive холбох»-оор дахин холбоно уу` };
  const r = await fetch(ABOUT(), { headers: { authorization: `Bearer ${String(t.j.access_token)}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { ok: false, info: `Drive хариу өгсөнгүй (HTTP ${r.status})` };
  const a = (await r.json()) as { user?: { emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } };
  const lim = Number(a.storageQuota?.limit ?? 0); const used = Number(a.storageQuota?.usage ?? 0);
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  return { ok: true, info: `${a.user?.emailAddress ?? s.email ?? ''} · ${lim ? `${gb(used)} / ${gb(lim)} GB ашигласан (${Math.round((used / lim) * 100)}%)` : `${gb(used)} GB ашигласан`}` };
}

/** «Одоо хуулбар авах» — backup контейнер минут тутам энэ тэмдгийг шалгаж нэг удаа ажиллана */
export async function requestBackupNow(actor: UserActor) {
  if (!isSA(actor)) throw forbidden();
  const at = new Date().toISOString();
  await mkdir(confDir(), { recursive: true });
  await writeFile(path.join(confDir(), 'backup-now'), at);
  await writeAudit(actor, 'settings.backup_now', 'AppSetting', KEY, { at }, undefined, ['settings', 'backup']);
  return { at };
}
