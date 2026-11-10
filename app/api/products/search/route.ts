import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { searchVariants } from '@/lib/services/products';

export const dynamic = 'force-dynamic';

/** Захиалга авахад бараа хайх (оператор ч ашиглана) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req);
    const sp = req.nextUrl.searchParams;
    return json({ items: await searchVariants(ctx.actor, sp.get('q') ?? '', Number(sp.get('limit')) || 20) });
  } catch (e) { return errorResponse(e); }
}
