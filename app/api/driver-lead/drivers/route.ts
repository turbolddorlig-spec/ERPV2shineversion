import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { driverOrdersByDay, driversList } from '@/lib/services/delivery/assign';

export const dynamic = 'force-dynamic';

/** Жолоочид (ачаалалтай); ?byDay=1 — «Жолоочдын захиалга» самбар */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    const sp = req.nextUrl.searchParams;
    if (sp.get('byDay') === '1') return json(await driverOrdersByDay(ctx.actor, sp.get('date') ?? undefined));
    return json(await driversList(ctx.actor, sp.get('date') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
