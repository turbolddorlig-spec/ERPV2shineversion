import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { driverIncome, submitSettlement, withdrawSettlement } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

/** Жолоочийн «Орлого» (?date) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await driverIncome(ctx.actor, req.nextUrl.searchParams.get('date') ?? undefined));
  } catch (e) { return errorResponse(e); }
}
/** { action: 'submit', date, cash, bank, debt } | { action: 'withdraw', date } */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json(body.action === 'withdraw' ? await withdrawSettlement(ctx.actor, body) : await submitSettlement(ctx.actor, body));
  } catch (e) { return errorResponse(e); }
}
