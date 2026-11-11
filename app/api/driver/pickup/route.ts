import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { pickUp, pickupList } from '@/lib/services/delivery/driver';

export const dynamic = 'force-dynamic';

/** «Авах» (Pickup, хуучин шиг): хуваарилаагүй «Шинэ» захиалгыг жолооч өөрөө авна */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    const sp = req.nextUrl.searchParams;
    return json(await pickupList(ctx.actor, { page: Number(sp.get('page')) || 1, district: sp.get('district') ?? undefined }));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await pickUp(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
