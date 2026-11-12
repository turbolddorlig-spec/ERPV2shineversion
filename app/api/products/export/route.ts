import type { NextRequest } from 'next/server';
import { PassThrough, Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { errorResponse, requireApiUser } from '@/lib/http';
import { exportBatches, STATUS_LABEL } from '@/lib/services/products';
import { canSeeCost } from '@/lib/permissions';
import { mediaUrl } from '@/lib/storage';
import { withHeavy } from '@/lib/heavy';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Бараа Excel (Аудит Б13, хувилбар бүрээр). Аудит #141: урсгалаар (stream) бичнэ — бараа 1000-аар уншиж, мөр бүрийг шууд
 * файлд гаргана (санах ой тогтмол бага). Нэг зэрэг зөвхөн 1 экспорт; бусад нь хүлээнэ / «ачаалалтай» хариу авна.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products' });
    const showCost = canSeeCost(ctx.actor.roles);
    const base = (process.env.APP_URL ?? '').replace(/\/$/, '');
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ulaanbaatar' });
    const out = new PassThrough();
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    // Хязгаарын суудлыг файл бичиж дуустал барина
    const started = new Promise<void>((resolve, reject) => {
      withHeavy(async () => { resolve(); await done; }, { name: 'products-export', max: 1 }).catch(reject);
    });
    await started;
    void (async () => {
      try {
        const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
        const ws = wb.addWorksheet('Бараа');
        ws.columns = [
          { header: 'Барааны код', key: 'code', width: 12 },
          { header: 'Хувилбарын код', key: 'vcode', width: 16 },
          { header: 'Нэр', key: 'name', width: 40 },
          { header: 'Өнгө', key: 'color', width: 14 },
          { header: 'Хэмжээ', key: 'size', width: 10 },
          { header: 'Ангилал', key: 'category', width: 18 },
          { header: 'Улирал', key: 'season', width: 12 },
          { header: 'Үнэ', key: 'price', width: 12 },
          ...(showCost ? [{ header: 'Өртөг', key: 'cost', width: 12 }] : []),
          { header: 'Агуулахад', key: 'total', width: 11 },
          { header: 'Захиалах боломжтой', key: 'available', width: 12 },
          { header: 'Төлөв', key: 'status', width: 12 },
          { header: 'Тайлбар', key: 'description', width: 50 },
          { header: 'Зураг', key: 'image', width: 50 },
        ];
        ws.getRow(1).font = { bold: true };
        ws.getRow(1).commit();
        for await (const { rows, stock } of exportBatches(ctx.actor)) {
          for (const r of rows) {
            for (const v of r.variants) {
              const img = r.images.find((i) => i.color && i.color === v.color) ?? r.images.find((i) => i.isMain) ?? r.images[0];
              const st = stock.get(v.id);
              ws.addRow({
                code: r.code, vcode: v.code, name: r.name, color: v.color, size: v.size, category: r.category?.name ?? '', season: r.season?.name ?? '',
                price: v.priceOverride ?? r.price, ...(showCost ? { cost: r.costPrice ?? '' } : {}),
                total: st?.total ?? 0, available: st?.available ?? 0, status: STATUS_LABEL[r.status], description: r.description ?? '',
                image: img ? `${base}${mediaUrl(img.fileKey, 'lg')}` : '',
              }).commit();
            }
          }
        }
        ws.commit();
        await wb.commit();
      } catch (e) {
        console.error('[products-export]', (e as Error).message);
        out.destroy(e as Error);
      } finally { release(); }
    })();
    return new Response(Readable.toWeb(out) as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="baraa-${date}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) { return errorResponse(e); }
}
