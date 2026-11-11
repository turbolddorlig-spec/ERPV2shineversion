import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { driverControl } from '@/lib/services/delivery/goods';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver-control' });
    return json(await driverControl(ctx.actor, req.nextUrl.searchParams.get('date') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
