import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { getOrderSettings, listAllPages, savePage, setOrderSettings } from '@/lib/services/orders/admin';
import { getMetaSettings, retryFailedMeta, setMetaSettings } from '@/lib/services/orders/meta';
import { getSmsSettings, previewSms, retryFailedSms, setSmsSettings, testSms } from '@/lib/services/orders/sms';
import { getIdleConfig, setIdleConfig } from '@/lib/services/orders/idle';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings' });
    const sa = ctx.actor.roles.includes('SUPER_ADMIN');
    const [settings, pages, meta, sms, idle] = await Promise.all([getOrderSettings(ctx.actor), listAllPages(ctx.actor), getMetaSettings(ctx.actor), sa ? getSmsSettings(ctx.actor) : null, getIdleConfig()]);
    return json({ settings, pages, meta, sms, idle });
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    if (body.kind === 'fees') return json({ settings: await setOrderSettings(ctx.actor, body) });
    if (body.kind === 'idle') return json({ idle: await setIdleConfig(ctx.actor, body) });
    if (body.kind === 'page') return json({ page: await savePage(ctx.actor, body) });
    if (body.kind === 'meta') return json({ meta: await setMetaSettings(ctx.actor, body) });
    if (body.kind === 'meta-retry') return json(await retryFailedMeta(ctx.actor));
    if (body.kind === 'sms') return json({ sms: await setSmsSettings(ctx.actor, body) });
    if (body.kind === 'sms-preview') return json(await previewSms(ctx.actor, body));
    if (body.kind === 'sms-test') return json(await testSms(ctx.actor));
    if (body.kind === 'sms-retry') return json(await retryFailedSms(ctx.actor));
    return json({ error: 'Төрөл буруу' }, 400);
  } catch (e) { return errorResponse(e); }
}
