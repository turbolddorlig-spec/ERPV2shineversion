import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { closeShortagesNow, driverDebtLedger } from '@/lib/services/accounting/debts';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { driverId: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting' });
    return json(await driverDebtLedger(ctx.actor, params.driverId, { page: Number(req.nextUrl.searchParams.get('page') ?? 1) }));
  } catch (e) { return errorResponse(e); }
}
/** Дутуу барааны өрийг одоо бодох (өдрийн эцсийг хүлээлгүй) */
export async function POST(req: NextRequest, { params }: { params: { driverId: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting', need: 'edit' });
    return json(await closeShortagesNow(ctx.actor, params.driverId));
  } catch (e) { return errorResponse(e); }
}
