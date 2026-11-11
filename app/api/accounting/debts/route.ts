import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { addDebt, dailyDebts, debtBoard } from '@/lib/services/accounting/debts';

export const dynamic = 'force-dynamic';

/** ?daily=YYYY-MM-DD — тухайн өдөр тавьсан / төлсөн өр; үгүй бол жолооч бүрийн нээлттэй өр */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting' });
    const daily = req.nextUrl.searchParams.get('daily');
    return json(daily ? await dailyDebts(ctx.actor, daily) : await debtBoard(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting', need: 'edit' });
    return json(await addDebt(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
