import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { gmailStatus, gmailSync, setGmailSettings } from '@/lib/services/accounting/gmail';
import { forbidden } from '@/lib/errors';
import { canBankImport, canEdit } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/** Gmail холболтын төлөв (нууц үг хэзээ ч буцаахгүй) — Тохиргоо (админ) ба Банкны импорт */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    return json(await gmailStatus(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
/** { action: 'settings', email, appPassword, sender, autoSync, minutes, days } | { action: 'disconnect' } | { action: 'sync', days } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    const body = await req.json().catch(() => ({}));
    if (body.action === 'settings') return json(await setGmailSettings(ctx.actor, body));
    if (body.action === 'disconnect') return json(await setGmailSettings(ctx.actor, { disconnect: true }));
    if (!canBankImport(ctx.actor.roles) && !canEdit(ctx.actor.roles, 'settings')) throw forbidden();
    return json(await gmailSync(ctx.actor, { days: Number(body.days) || undefined }));
  } catch (e) { return errorResponse(e); }
}
