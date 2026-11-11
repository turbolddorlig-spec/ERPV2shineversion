import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse, requireApiUser } from '@/lib/http';
import { exportCsv } from '@/lib/services/accounting/bank';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import' });
    const sp = req.nextUrl.searchParams;
    const csv = await exportCsv(ctx.actor, { tab: sp.get('tab') ?? undefined, q: sp.get('q') ?? undefined, from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined });
    return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bank-${Date.now()}.csv"`, 'Cache-Control': 'no-store' } });
  } catch (e) { return errorResponse(e); }
}
