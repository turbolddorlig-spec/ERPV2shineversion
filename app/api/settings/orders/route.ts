import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { getOrderSettings, listAllPages, savePage, setOrderSettings } from '@/lib/services/orders/admin';
import { getMetaSettings, retryFailedMeta, setMetaSettings } from '@/lib/services/orders/meta';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings' });
    const [settings, pages, meta] = await Promise.all([getOrderSettings(ctx.actor), listAllPages(ctx.actor), getMetaSettings(ctx.actor)]);
    return json({ settings, pages, meta });
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (body.kind === 'fees') return json({ settings: await setOrderSettings(ctx.actor, body) });
    if (body.kind === 'page') return json({ page: await savePage(ctx.actor, body) });
    if (body.kind === 'meta') return json({ meta: await setMetaSettings(ctx.actor, body) });
    if (body.kind === 'meta-retry') return json(await retryFailedMeta(ctx.actor));
    return json({ error: 'Төрөл буруу' }, 400);
  } catch (e) { return errorResponse(e); }
}
