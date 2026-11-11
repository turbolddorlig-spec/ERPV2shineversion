import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { driverDebtLedger } from '@/lib/services/accounting/debts';

export const dynamic = 'force-dynamic';

/** Жолоочийн «Төлбөр тооцоо» — компанид өгөх өр (зөвхөн харах) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await driverDebtLedger(ctx.actor, ctx.actor.id, { page: Number(req.nextUrl.searchParams.get('page') ?? 1) }));
  } catch (e) { return errorResponse(e); }
}
