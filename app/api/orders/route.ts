import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createOrder } from '@/lib/services/orders/orders';
import { listOrders } from '@/lib/services/orders/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    const sp = req.nextUrl.searchParams;
    const b = (k: string) => sp.get(k) === '1';
    return json(await listOrders(ctx.actor, {
      tab: sp.get('tab') ?? undefined, q: sp.get('q') ?? undefined, from: sp.get('from') || undefined, to: sp.get('to') || undefined,
      operatorId: sp.get('operatorId') || undefined, pageId: Number(sp.get('pageId')) || undefined, province: sp.get('province') || undefined,
      district: sp.get('district') || undefined, prepaid: b('prepaid'), noKhoroo: b('noKhoroo'), postponed: b('postponed'), todayDelivery: b('todayDelivery'),
      page: Number(sp.get('page')) || 1, statuses: sp.has('statuses') ? sp.get('statuses') ?? '' : undefined,
    }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders', need: 'edit' });
    const r = await createOrder(ctx.actor, await req.json().catch(() => ({})));
    return json(r, r.duplicate ? 200 : 201);
  } catch (e) { return errorResponse(e); }
}
