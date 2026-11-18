import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { extrasBoard, settleExtras } from '@/lib/services/accounting/extras';

export const dynamic = 'force-dynamic';

/** #175 Нэмэлт барааны тусдаа тооцоо (?date) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting' });
    return json(await extrasBoard(ctx.actor, req.nextUrl.searchParams.get('date') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
/** «Нэмэлтийн мөнгө авсан» { driverId, date } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json(await settleExtras(ctx.actor, body));
  } catch (e) { return errorResponse(e); }
}
