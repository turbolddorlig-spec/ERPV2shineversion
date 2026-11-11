import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { driverOrders } from '@/lib/services/delivery/driver';

export const dynamic = 'force-dynamic';

/** Жолоочийн табууд: all | delivery | delivered | cancelled | tomorrow | yesterday */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await driverOrders(ctx.actor, req.nextUrl.searchParams.get('tab') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
