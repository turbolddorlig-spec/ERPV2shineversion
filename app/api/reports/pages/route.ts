import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { pageProducts, pageReport } from '@/lib/services/orders/reports';
import { withHeavy } from '@/lib/heavy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'reports' });
    const sp = req.nextUrl.searchParams;
    const p = { from: sp.get('from') || undefined, to: sp.get('to') || undefined, pageId: Number(sp.get('pageId')) || undefined };
    // Аудит #141: хүнд тайлан — зэрэг тоо хязгаартай
    if (sp.get('by') === 'product') return json({ products: await withHeavy(() => pageProducts(ctx.actor, p)) });
    return json(await withHeavy(() => pageReport(ctx.actor, { ...p, by: sp.get('by') || undefined })));
  } catch (e) { return errorResponse(e); }
}
