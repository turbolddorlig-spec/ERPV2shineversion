import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { notFound } from '@/lib/errors';
import { createNotice, deleteNotice, listNotices, markRead } from '@/lib/services/supplier-notice';

export const dynamic = 'force-dynamic';

/** #215: нийлүүлэгчид мэдэгдэл — жагсаалт (СА, Админ) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'supplier' });
    return json(await listNotices(ctx.actor));
  } catch (e) { return errorResponse(e); }
}

/** action: create { shopId | 'all', text } · delete { id } (СА, Админ) · read { id } (нийлүүлэгч) — эрхийг үйлчилгээ шалгана */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'supplier' });
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (b.action === 'create') return json(await createNotice(ctx.actor, b));
    if (b.action === 'delete') return json(await deleteNotice(ctx.actor, b.id));
    if (b.action === 'read') return json(await markRead(ctx.actor, b.id));
    throw notFound();
  } catch (e) { return errorResponse(e); }
}
