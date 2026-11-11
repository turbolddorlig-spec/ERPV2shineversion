import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { importCsv } from '@/lib/services/accounting/bank';

export const dynamic = 'force-dynamic';

/** { text } — CSV файлын агуулга */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'bank-import', need: 'edit' });
    return json(await importCsv(ctx.actor, await req.json().catch(() => ({}))));
  } catch (e) { return errorResponse(e); }
}
