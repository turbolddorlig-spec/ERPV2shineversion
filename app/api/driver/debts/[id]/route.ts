import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { markDebtPaid } from '@/lib/services/delivery/driver';

export const dynamic = 'force-dynamic';

/** «Төлсөн» — үйлчлүүлэгч мөнгөө өгсөн */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'driver', need: 'edit' });
    return json(await markDebtPaid(ctx.actor, params.id));
  } catch (e) { return errorResponse(e); }
}
