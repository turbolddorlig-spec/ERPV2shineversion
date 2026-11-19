import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Role } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { UserActor } from '@/lib/services/users';
import { resetDb } from '../helpers/reset';

/** #171 Нөөц хуулбар — Google Drive-ийг Тохиргооноос холбох (Google хуурамч, жинхэнэ хандалтгүй) */
let db: typeof import('@/lib/db').db;
let G: typeof import('@/lib/services/drive-backup');
let dir = '';
beforeAll(async () => {
  db = (await import('@/lib/db')).db;
  G = await import('@/lib/services/drive-backup');
});
let seq = 0;
async function actor(roles: Role[]): Promise<UserActor> {
  seq++;
  const u = await db.user.create({ data: { phone: String(77000000 + seq), name: `${roles.join('+')} ${seq}`, roles, passwordHash: 'x' } });
  return { id: u.id, name: u.name, roles: u.roles, ip: '127.0.0.1' };
}
async function err(p: Promise<unknown>, status: number): Promise<AppError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(status); return e as AppError; }
  throw new Error(`Алдаа гарах ёстой байсан (${status})`);
}
const ORIGIN = 'https://erp.example.mn';
const CID = '123456-abc.apps.googleusercontent.com';
const SECRET = 'GOCSPX-DUMMYSECRET0001';
type Call = { url: string; body: string; auth?: string };
let calls: Call[] = [];
let sa: UserActor; let admin: UserActor;

beforeEach(async () => {
  await resetDb(db as never);
  dir = await mkdtemp(path.join(tmpdir(), 'drive-'));
  process.env.DRIVE_CONF_DIR = dir;
  process.env.APP_URL = ORIGIN;
  sa = await actor(['SUPER_ADMIN']); admin = await actor(['ADMIN']);
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? ''), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (url.includes('/token')) {
      const b = new URLSearchParams(String(init?.body));
      if (b.get('grant_type') === 'authorization_code') return new Response(JSON.stringify({ access_token: 'AT1', refresh_token: b.get('code') === 'code2' ? 'RT2' : b.get('code') === 'noscope' ? 'RT9' : b.get('code') === 'code3' ? 'RT3' : 'RT1', expires_in: 3599, scope: b.get('code') === 'noscope' ? 'openid https://www.googleapis.com/auth/userinfo.email' : 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file' }), { status: 200 });
      return new Response(JSON.stringify({ access_token: 'AT-refresh', expires_in: 3599 }), { status: 200 });
    }
    if (url.includes('userinfo')) return new Response(JSON.stringify({ email: calls.some((c) => c.body.includes('code=code2')) ? 'company2.backup@gmail.com' : 'zahialga.backup@gmail.com' }), { status: 200 });
    if (url.includes('/revoke')) return new Response('', { status: 200 });
    if (url.includes('drive/v3/about')) return new Response(JSON.stringify({ user: { emailAddress: 'zahialga.backup@gmail.com' }, storageQuota: { limit: String(15 * 1024 ** 3), usage: String(3 * 1024 ** 3) } }), { status: 200 });
    return new Response('nf', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.DRIVE_CONF_DIR; delete process.env.APP_URL; });

async function connect(code = 'code1') {
  const url = new URL(await G.driveAuthUrl(sa, ORIGIN));
  return G.driveCallback(sa, { code, state: url.searchParams.get('state') }, ORIGIN);
}

describe('#171 Google Drive холбох', () => {
  it('эрх: зөвхөн Супер админ; Client ID/Secret шалгалт; secret хариунд гарахгүй', async () => {
    await err(G.getDriveSettings(admin, ORIGIN), 403);
    await err(G.saveDriveClient(admin, { clientId: CID }), 403);
    await err(G.saveDriveClient(sa, { clientId: 'https://x' }), 400);
    await err(G.saveDriveClient(sa, { clientId: CID, clientSecret: 'https://a/b' }), 400);
    await err(G.driveAuthUrl(sa, ORIGIN), 400); // client алга
    await G.saveDriveClient(sa, { clientId: CID, clientSecret: SECRET });
    const s = await G.getDriveSettings(sa, ORIGIN);
    expect(s).toMatchObject({ clientId: CID, secretSet: true, connected: false, redirectUri: `${ORIGIN}/api/settings/drive/callback` });
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it('холбох: зөвшөөрлийн хаяг → буцах → токен шифрлэгдэж, rclone.conf (600) бичигдэнэ, түүхэнд нууцгүй', async () => {
    await G.saveDriveClient(sa, { clientId: CID, clientSecret: SECRET });
    const u = new URL(await G.driveAuthUrl(sa, ORIGIN));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toContain('auth/drive.file');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/settings/drive/callback`);
    const r = await G.driveCallback(sa, { code: 'code1', state: u.searchParams.get('state') }, ORIGIN);
    expect(r.email).toBe('zahialga.backup@gmail.com');
    const conf = await readFile(path.join(dir, 'rclone.conf'), 'utf8');
    expect(conf).toContain('[gdrive]'); expect(conf).toContain('type = drive'); expect(conf).toContain('scope = drive.file');
    expect(conf).toContain(`client_id = ${CID}`); expect(conf).toContain(`client_secret = ${SECRET}`);
    expect(conf).toContain('"refresh_token":"RT1"');
    expect((await stat(path.join(dir, 'rclone.conf'))).mode & 0o777).toBe(0o600);
    const s = await G.getDriveSettings(sa, ORIGIN);
    expect(s).toMatchObject({ connected: true, email: 'zahialga.backup@gmail.com', confWritten: true });
    const row = await db.appSetting.findUniqueOrThrow({ where: { key: 'driveBackup' } });
    expect(JSON.stringify(row.value)).not.toContain('RT1'); // шифрлэгдсэн
    const logs = await db.auditLog.findMany({ where: { tags: { has: 'backup' } } });
    expect(JSON.stringify(logs.map((l) => l.details))).not.toMatch(/RT1|GOCSPX/);
    expect(logs.map((l) => l.action)).toContain('settings.drive_connected');
  });

  it('буруу / хуучирсан state, татгалзсан зөвшөөрөл → холбогдохгүй', async () => {
    await G.saveDriveClient(sa, { clientId: CID, clientSecret: SECRET });
    await G.driveAuthUrl(sa, ORIGIN);
    await err(G.driveCallback(sa, { code: 'code1', state: 'хуурамч' }, ORIGIN), 400);
    await err(G.driveCallback(sa, { error: 'access_denied' }, ORIGIN), 400);
    // Drive-ийн чагтыг тэмдэглээгүй (зөвхөн имэйл эрх) → холбогдохгүй, токен цуцлагдана
    const u2 = new URL(await G.driveAuthUrl(sa, ORIGIN));
    await err(G.driveCallback(sa, { code: 'noscope', state: u2.searchParams.get('state') }, ORIGIN), 400);
    expect(calls.some((c) => c.url.includes('/revoke') && c.body.includes('token=RT9'))).toBe(true);
    expect((await G.getDriveSettings(sa, ORIGIN)).connected).toBe(false);
  });

  it('өөр Drive холбох: шинэ бүртгэл, хуучин токен цуцлагдана; шалгах; одоо хуулбар; салгах', async () => {
    await G.saveDriveClient(sa, { clientId: CID, clientSecret: SECRET });
    await connect('code1');
    // #180: ижил бүртгэлийг дахин холбоход хуучин токеныг цуцлахгүй (Google шинийг ч хамт цуцалдаг)
    await connect('code3');
    expect(calls.some((c) => c.url.includes('/revoke'))).toBe(false);
    await connect('code2');
    expect((await G.getDriveSettings(sa, ORIGIN)).email).toBe('company2.backup@gmail.com');
    expect(calls.some((c) => c.url.includes('/revoke') && c.body.includes('token=RT3'))).toBe(true);
    expect(await readFile(path.join(dir, 'rclone.conf'), 'utf8')).toContain('"refresh_token":"RT2"');
    const t = await G.testDrive(sa);
    expect(t.ok).toBe(true); expect(t.info).toContain('3.0 / 15.0 GB');
    await G.requestBackupNow(sa);
    expect((await readFile(path.join(dir, 'backup-now'), 'utf8')).length).toBeGreaterThan(10);
    await G.disconnectDrive(sa);
    await expect(stat(path.join(dir, 'rclone.conf'))).rejects.toThrow();
    expect(calls.some((c) => c.url.includes('/revoke') && c.body.includes('token=RT2'))).toBe(true);
    expect((await G.getDriveSettings(sa, ORIGIN))).toMatchObject({ connected: false, email: null, clientId: CID, secretSet: true });
    await err(G.testDrive(sa), 400);
  });
});
