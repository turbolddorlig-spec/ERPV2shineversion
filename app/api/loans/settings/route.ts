import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { setLoanDiscount } from '@/lib/services/stock/loans';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'loans', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json(await setLoanDiscount(ctx.actor, body.loanDiscount));
  } catch (e) { return errorResponse(e); }
}
