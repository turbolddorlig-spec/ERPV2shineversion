import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { addressMatches } from '@/lib/services/orders/queries';

export const dynamic = 'force-dynamic';

/** #172-2: ижил хаяг өөр утасны идэвхтэй захиалгад байгаа эсэх (анхааруулга) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'orders' });
    const sp = req.nextUrl.searchParams;
    return json(await addressMatches(ctx.actor, { province: sp.get('province'), district: sp.get('district'), khoroo: sp.get('khoroo') || null, addressDetail: sp.get('detail'), phones: sp.getAll('phone') }));
  } catch (e) { return errorResponse(e); }
}
