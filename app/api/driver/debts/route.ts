import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { myDebts } from '@/lib/services/delivery/driver';

export const dynamic = 'force-dynamic';

/** Жолоочийн хувийн «Өрийн дэвтэр» (?paid=1 — төлөгдсөн) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await myDebts(ctx.actor, { paid: req.nextUrl.searchParams.get('paid') === '1' }));
  } catch (e) { return errorResponse(e); }
}
