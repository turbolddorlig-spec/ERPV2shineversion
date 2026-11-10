import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { pageProducts, pageReport } from '@/lib/services/orders/reports';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'reports' });
    const sp = req.nextUrl.searchParams;
    const p = { from: sp.get('from') || undefined, to: sp.get('to') || undefined, pageId: Number(sp.get('pageId')) || undefined };
    if (sp.get('by') === 'product') return json({ products: await pageProducts(ctx.actor, p) });
    return json(await pageReport(ctx.actor, { ...p, by: sp.get('by') || undefined }));
  } catch (e) { return errorResponse(e); }
}
