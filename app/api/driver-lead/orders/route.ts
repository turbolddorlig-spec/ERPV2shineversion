import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { leadOrders } from '@/lib/services/delivery/assign';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver-lead' });
    const sp = req.nextUrl.searchParams;
    return json(await leadOrders(ctx.actor, {
      q: sp.get('q') ?? undefined, assign: sp.get('assign') ?? undefined, deliveryDate: sp.get('deliveryDate') || undefined, created: sp.get('created') || undefined,
      district: sp.get('district') || undefined, rural: sp.get('rural') === '1', status: sp.get('status') || undefined, driverId: sp.get('driverId') || undefined,
      page: Number(sp.get('page')) || 1, pageSize: Number(sp.get('pageSize')) || 50,
    }));
  } catch (e) { return errorResponse(e); }
}
