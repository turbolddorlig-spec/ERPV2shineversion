import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { extraSale, extraTake, myGoods } from '@/lib/services/delivery/goods';

export const dynamic = 'force-dynamic';

/** Миний бараа (гарт, хүргэлтэд, буцаах) + нэмэлт бараа авах / зарсан */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await myGoods(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json(body.kind === 'sale' ? await extraSale(ctx.actor, body) : await extraTake(ctx.actor, body));
  } catch (e) { return errorResponse(e); }
}
