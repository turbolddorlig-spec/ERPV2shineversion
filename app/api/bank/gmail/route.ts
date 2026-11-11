import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { gmailStatus, gmailSync, setGmailSettings } from '@/lib/services/accounting/gmail';
import { forbidden } from '@/lib/errors';
import { canBankImport } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    return json(await gmailStatus(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
/** { action: 'sync', days } | { action: 'settings', sender, autoSync, minutes, days } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (body.action === 'settings') return json(await setGmailSettings(ctx.actor, body));
    if (!canBankImport(ctx.actor.roles)) throw forbidden();
    return json(await gmailSync(ctx.actor, { days: Number(body.days) || undefined }));
  } catch (e) { return errorResponse(e); }
}
