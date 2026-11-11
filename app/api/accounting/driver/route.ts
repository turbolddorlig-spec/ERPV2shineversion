import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { accountingDriver } from '@/lib/services/accounting/settle';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'accounting' });
    const sp = req.nextUrl.searchParams;
    return json(await accountingDriver(ctx.actor, sp.get('driverId'), sp.get('date')));
  } catch (e) { return errorResponse(e); }
}
