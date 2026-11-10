import { readFile } from 'node:fs/promises';
import { resolveMediaPath } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Барааны зураг. Production-д Caddy шууд дискнээс өгнө (хурдан); энэ нь хөгжүүлэлт/нөөц зам.
 * Файлын нэр UUID тул өөрчлөгдөхгүй → удаан cache.
 */
export async function GET(_req: Request, { params }: { params: { path: string[] } }) {
  const file = resolveMediaPath(params.path ?? []);
  if (!file) return new Response('Not found', { status: 404 });
  try {
    const data = await readFile(file);
    return new Response(data, { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
