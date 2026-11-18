import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { disconnectDrive, getDriveSettings, requestBackupNow, saveDriveClient, testDrive } from '@/lib/services/drive-backup';

export const dynamic = 'force-dynamic';

/** #171 Нөөц хуулбар — Google Drive (зөвхөн Супер админ; сервис дотор шалгана) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings' });
    return json(await getDriveSettings(ctx.actor, req.nextUrl.origin));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (body.kind === 'client') { await saveDriveClient(ctx.actor, body); return json(await getDriveSettings(ctx.actor, req.nextUrl.origin)); }
    if (body.kind === 'disconnect') { await disconnectDrive(ctx.actor); return json(await getDriveSettings(ctx.actor, req.nextUrl.origin)); }
    if (body.kind === 'test') return json(await testDrive(ctx.actor));
    if (body.kind === 'backup-now') return json(await requestBackupNow(ctx.actor));
    return json({ error: 'Төрөл буруу' }, 400);
  } catch (e) { return errorResponse(e); }
}
