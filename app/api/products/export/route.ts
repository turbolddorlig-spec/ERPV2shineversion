import type { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { errorResponse, requireApiUser } from '@/lib/http';
import { exportRows, STATUS_LABEL } from '@/lib/services/products';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'products' });
    const { showCost, rows } = await exportRows(ctx.actor);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Бараа');
    ws.columns = [
      { header: 'Код', key: 'code', width: 14 },
      { header: 'Нэр', key: 'name', width: 40 },
      { header: 'Ангилал', key: 'category', width: 18 },
      { header: 'Улирал', key: 'season', width: 12 },
      { header: 'Үнэ', key: 'price', width: 12 },
      ...(showCost ? [{ header: 'Өртөг', key: 'cost', width: 12 }] : []),
      { header: 'Төлөв', key: 'status', width: 12 },
      { header: 'Хувилбарын тоо', key: 'vcount', width: 10 },
      { header: 'Хувилбарууд', key: 'variants', width: 60 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        code: r.code, name: r.name, category: r.category?.name ?? '', season: r.season?.name ?? '', price: r.price,
        ...(showCost ? { cost: r.costPrice ?? '' } : {}), status: STATUS_LABEL[r.status], vcount: r.variants.length,
        variants: r.variants.map((v) => v.code + (v.priceOverride ? ` (₮${v.priceOverride})` : '')).join(', '),
      });
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
