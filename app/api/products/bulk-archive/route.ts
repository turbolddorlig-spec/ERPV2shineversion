import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { archivableCount, bulkArchive } from '@/lib/services/products';

export const dynamic = 'force-dynamic';

/** #187: зогсоосон, үлдэгдэлгүй барааг олноор архивлах (баталгаажуулах үгтэй) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    return json(await archivableCount(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    return json(await bulkArchive(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
