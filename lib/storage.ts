import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { badRequest } from './errors';

/**
 * Барааны зургийг серверийн дискэнд хадгална (шийдвэр #25).
 * Нэг зургаас 3 хэмжээ: sm (жагсаалт), md (харах), lg (томруулах). Бүгд WEBP.
 * Файлын нэр санамсаргүй UUID — өөрчлөгдөхгүй тул браузер удаан cache хийнэ.
 */
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'data', 'uploads');
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SIZES = { sm: 320, md: 800, lg: 1600 } as const;
export type ImageSize = keyof typeof SIZES;

export function mediaUrl(fileKey: string, size: ImageSize): string {
  return `/media/${fileKey}-${size}.webp`;
}

export async function saveProductImage(productId: number, data: Buffer): Promise<{ fileKey: string; width: number; height: number; bytes: number }> {
  if (data.length === 0) throw badRequest('Зураг хоосон байна', 'image_empty');
  if (data.length > MAX_IMAGE_BYTES) throw badRequest('Зураг 10MB-аас том байна', 'image_too_large');

  let meta: sharp.Metadata;
  try {
    meta = await sharp(data, { failOn: 'error' }).metadata();
  } catch {
    throw badRequest('Зургийн файл биш эсвэл эвдэрсэн байна (JPG, PNG, WEBP)', 'image_invalid');
  }
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
    throw badRequest('Зөвхөн JPG, PNG, WEBP зураг оруулна уу', 'image_type');
  }
  if (!meta.width || !meta.height || meta.width > 12000 || meta.height > 12000) {
    throw badRequest('Зургийн хэмжээ хэт том байна', 'image_dimensions');
  }

  const fileKey = `products/${productId}/${randomUUID()}`;
  const dir = path.join(UPLOAD_DIR, path.dirname(fileKey));
  await mkdir(dir, { recursive: true });

  let width = meta.width;
  let height = meta.height;
  for (const [size, px] of Object.entries(SIZES) as [ImageSize, number][]) {
    const out = await sharp(data).rotate().resize(px, px, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: size === 'sm' ? 72 : 82 }).toBuffer({ resolveWithObject: true });
    if (size === 'lg') { width = out.info.width; height = out.info.height; }
    const final = path.join(UPLOAD_DIR, `${fileKey}-${size}.webp`);
    await writeFile(final + '.tmp', out.data);
    await rename(final + '.tmp', final);
  }
  return { fileKey, width, height, bytes: data.length };
}

/** /media/... хүсэлтийн замыг аюулгүй файлын зам болгоно (хавтаснаас гарахыг хориглоно) */
export function resolveMediaPath(parts: string[]): string | null {
  const rel = parts.join('/');
  if (!/^products\/\d+\/[0-9a-f-]{36}-(sm|md|lg)\.webp$/.test(rel)) return null;
  return path.join(UPLOAD_DIR, rel);
}
