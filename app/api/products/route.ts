import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { createProduct, listProducts } from '@/lib/services/products';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products' });
    const sp = req.nextUrl.searchParams;
    const st = sp.get('status');
    return json(await listProducts(ctx.actor, {
      q: sp.get('q') ?? undefined,
      categoryId: Number(sp.get('categoryId')) || undefined,
      seasonId: Number(sp.get('seasonId')) || undefined,
      status: st === 'active' || st === 'discontinued' || st === 'archived' || st === 'all' ? st : 'live',
      page: Number(sp.get('page')) || 1,
    }));
  } catch (e) { return errorResponse(e); }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products', need: 'edit' });
    const body = await req.json().catch(() => ({}));
    return json({ product: await createProduct(ctx.actor, body) }, 201);
  } catch (e) { return errorResponse(e); }
}
