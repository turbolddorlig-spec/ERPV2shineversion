import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { forceCloseSettlement } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

/** Нягтлан өдрийг хүчээр хаах (#141): { driverId, date, cash, bank, note } — дутуу нь жолоочийн өр */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting', need: 'edit' });
    return json(await forceCloseSettlement(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
