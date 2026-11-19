import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { disableSms, getIncomingSettings, rotateKey, setAccounts } from '@/lib/services/accounting/bank-sms';

export const dynamic = 'force-dynamic';

/** #181 Банкны орлого утаснаас + дансны шүүлтүүр (зөвхөн Супер админ — сервис дотор) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings' });
    return json(await getIncomingSettings(ctx.actor, req.nextUrl.origin));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    const b = await req.json().catch(() => ({}));
    if (b.kind === 'accounts') await setAccounts(ctx.actor, b.accounts);
    else if (b.kind === 'rotate') await rotateKey(ctx.actor);
    else if (b.kind === 'disable') await disableSms(ctx.actor);
    return json(await getIncomingSettings(ctx.actor, req.nextUrl.origin));
  } catch (e) { return errorResponse(e); }
}
