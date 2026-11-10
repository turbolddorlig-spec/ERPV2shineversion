import type { NextRequest } from 'next/server';
import { errorResponse, json, requireApiUser } from '@/lib/http';
import { userHistory } from '@/lib/services/users';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireApiUser(req, { page: 'users' });
    return json(await userHistory(ctx.actor, params.id, Number(req.nextUrl.searchParams.get('page') ?? 1) || 1));
  } catch (e) {
    return errorResponse(e);
  }
}
