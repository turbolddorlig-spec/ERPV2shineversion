import type { NextRequest } from 'next/server';
import { readLogoFile } from '@/lib/services/brand';

export const dynamic = 'force-dynamic';

/** #177 Лого (нийтэд — нэвтрэх хуудас, tab-ын дүрс). Хаяг нь хувилбартай (?v=) тул удаан cache */
export async function GET(_req: NextRequest, { params }: { params: { file: string } }) {
  const buf = await readLogoFile(params.file);
  if (!buf) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
}
