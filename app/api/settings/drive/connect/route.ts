import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse, requireApiUser } from '@/lib/http';
import { driveAuthUrl } from '@/lib/services/drive-backup';

export const dynamic = 'force-dynamic';

/** «Google Drive холбох» — Google-ийн зөвшөөрлийн хуудас руу */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'settings', need: 'edit' });
    return NextResponse.redirect(await driveAuthUrl(ctx.actor, req.nextUrl.origin));
  } catch (e) { return errorResponse(e); }
}
