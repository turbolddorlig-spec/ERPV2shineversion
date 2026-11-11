import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { accountingDay } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

/** Нягтлангийн өдрийн самбар (?date&driverId&status&prepaid) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting' });
    const sp = req.nextUrl.searchParams;
    return json(await accountingDay(ctx.actor, sp.get('date') ?? undefined, { driverId: sp.get('driverId') ?? undefined, status: sp.get('status') ?? undefined, prepaid: sp.get('prepaid') ?? undefined }));
  } catch (e) { return errorResponse(e); }
}
