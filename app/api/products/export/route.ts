import type { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { errorResponse, requireApiUser } from '@/lib/http';
import { exportRows, STATUS_LABEL } from '@/lib/services/products';
import { mediaUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products' });
    const { showCost, rows, stock } = await exportRows(ctx.actor);
    const base = (process.env.APP_URL ?? '').replace(/\/$/, '');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Бараа');
    // Аудит Б13 (хуучин ERP шиг): өнгө / хэмжээ бүрээр нэг мөр
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
    for (const r of rows) {
      for (const v of r.variants) {
        const img = r.images.find((i) => i.color && i.color === v.color) ?? r.images.find((i) => i.isMain) ?? r.images[0];
        const st = stock.get(v.id);
        ws.addRow({
          code: r.code, vcode: v.code, name: r.name, color: v.color, size: v.size, category: r.category?.name ?? '', season: r.season?.name ?? '',
          price: v.priceOverride ?? r.price, ...(showCost ? { cost: r.costPrice ?? '' } : {}),
          total: st?.total ?? 0, available: st?.available ?? 0, status: STATUS_LABEL[r.status], description: r.description ?? '',
          image: img ? `${base}${mediaUrl(img.fileKey, 'lg')}` : '',
        });
      }
    }
    const buf = await wb.xlsx.writeBuffer();
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ulaanbaatar' });
    return new Response(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="baraa-${date}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) { return errorResponse(e); }
}
