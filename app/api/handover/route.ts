import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createHandover, driverDay, handoverBoard, handoverHistory } from '@/lib/services/delivery/handover';

export const dynamic = 'force-dynamic';

/** ?date= — жолооч сонгох самбар; ?driverId=&date= — жолоочийн өдөр; ?history=1&from=&to=&driverId= — түүх */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'handover' });
    const sp = req.nextUrl.searchParams;
    if (sp.get('history') === '1') return json(await handoverHistory(ctx.actor, { from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, driverId: sp.get('driverId') || undefined }));
    if (sp.get('driverId')) return json(await driverDay(ctx.actor, { driverId: sp.get('driverId'), date: sp.get('date') }));
    return json(await handoverBoard(ctx.actor, sp.get('date') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'handover', need: 'edit' });
    return json({ handover: await createHandover(ctx.actor, await req.json().catch(() => ({}))) }, 201);
  } catch (e) { return errorResponse(e); }
}
