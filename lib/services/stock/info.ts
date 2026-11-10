import { db } from '../../db';
import { mediaUrl } from '../../storage';
import { variantLabel } from '../../catalog/variants';

/** Мөрөнд харуулах барааны мэдээлэл (нэр, код, өнгө/хэмжээ, зураг, тавиур) */
export async function variantInfo(ids: number[]) {
  if (!ids.length) return new Map<number, { code: string; name: string; label: string; productId: number; thumb: string | null; shelfCode: string | null }>();
  const rows = await db.productVariant.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, code: true, color: true, size: true,
      product: { select: { id: true, name: true, shelfCode: true, colors: true, sizes: true, images: { orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }], select: { fileKey: true, color: true } } } },
    },
  });
  return new Map(rows.map((v) => {
    const img = v.product.images.find((i) => v.color && i.color === v.color) ?? v.product.images[0];
    return [v.id, {
      code: v.code, name: v.product.name, label: v.color || v.size ? variantLabel(v) : '', productId: v.product.id,
      thumb: img ? mediaUrl(img.fileKey, 'sm') : null, shelfCode: v.product.shelfCode,
    }];
  }));
}

