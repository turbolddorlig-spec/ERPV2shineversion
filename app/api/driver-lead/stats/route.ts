import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { leadChart, leadPerformance } from '@/lib/services/delivery/assign';

export const dynamic = 'force-dynamic';

/** ?kind=performance&from&to&driverId — «Жолоочийн гүйцэтгэл»; ?kind=chart&days&driverId — «График» */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver-lead' });
    const sp = req.nextUrl.searchParams;
    const driverId = sp.get('driverId') || undefined;
    if (sp.get('kind') === 'chart') return json(await leadChart(ctx.actor, { days: Number(sp.get('days')) || 14, driverId }));
    return json(await leadPerformance(ctx.actor, { from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, driverId }));
  } catch (e) { return errorResponse(e); }
}
