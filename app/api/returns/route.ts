import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { driverReturnable, receiveReturn, returnsBoard } from '@/lib/services/delivery/goods';

export const dynamic = 'force-dynamic';

/** Буцаалт хүлээн авах: ?driverId= бол тухайн жолоочийн буцаах бараа, үгүй бол самбар */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    const d = req.nextUrl.searchParams.get('driverId');
    return json(d ? await driverReturnable(ctx.actor, d) : await returnsBoard(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    return json(await receiveReturn(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
