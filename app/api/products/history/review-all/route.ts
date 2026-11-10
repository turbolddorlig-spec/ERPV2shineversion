import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { reviewAllProductEdits } from '@/lib/services/product-history';

export const dynamic = 'force-dynamic';

/** Шалгаагүй бүх барааны засварыг "Шалгасан" болгох (зөвхөн Супер админ — сервис дотор шалгана) */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'product-history', need: 'edit' });
    return json(await reviewAllProductEdits(ctx.actor));
  } catch (e) { return errorResponse(e); }
}
