import type { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { errorResponse, requireApiUser } from '@/lib/http';
import { callAnalysis, pageProducts, pageReport } from '@/lib/services/orders/reports';
import { withHeavy } from '@/lib/heavy';

export const dynamic = 'force-dynamic';

/** Тайлангийн Excel: kind=pages (пэйж / оператор / өдөр / бараа) эсвэл kind=calls (дуудлагын шинжилгээ, утасны жагсаалт) */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireApiUser(req, { page: 'reports' });
    const sp = req.nextUrl.searchParams;
    const p = { from: sp.get('from') || undefined, to: sp.get('to') || undefined, pageId: Number(sp.get('pageId')) || undefined };
    const wb = new ExcelJS.Workbook();
    let name = 'tailan';
    if (sp.get('kind') === 'calls') {
      const r = await withHeavy(() => callAnalysis(ctx.actor, { ...p, bucket: sp.get('bucket') || undefined, by: sp.get('by') || undefined }));
      const ws = wb.addWorksheet('Дуудлага');
      ws.columns = [{ header: 'Шалтгаан', key: 'label', width: 26 }, { header: 'Тоо', key: 'n', width: 10 }, { header: '%', key: 'pct', width: 8 }];
      ws.getRow(1).font = { bold: true };
      r.buckets.forEach((b) => ws.addRow(b));
      if (r.phones.length) {
        const w2 = wb.addWorksheet('Утаснууд');
        w2.columns = [{ header: 'Утас', key: 'phone', width: 12 }, { header: 'Бараа', key: 'product', width: 40 }, { header: 'Пэйж', key: 'page', width: 22 }, { header: 'Оператор', key: 'operator', width: 22 }, { header: 'Огноо', key: 'createdAt', width: 20 }];
        w2.getRow(1).font = { bold: true };
        r.phones.forEach((x) => w2.addRow(x));
      }
      name = `duudlaga-${r.from}-${r.to}`;
    } else if (sp.get('by') === 'product') {
      const rows = await withHeavy(() => pageProducts(ctx.actor, p));
      const ws = wb.addWorksheet('Бараа');
      ws.columns = [{ header: 'Код', key: 'code', width: 16 }, { header: 'Бараа', key: 'name', width: 40 }, { header: 'Өнгө/хэмжээ', key: 'label', width: 16 }, { header: 'Ширхэг', key: 'qty', width: 10 }, { header: 'Захиалга', key: 'orders', width: 10 }];
      ws.getRow(1).font = { bold: true };
      rows.forEach((x) => ws.addRow(x));
      name = 'peij-baraa';
    } else {
      const r = await withHeavy(() => pageReport(ctx.actor, { ...p, by: sp.get('by') || undefined }));
      const ws = wb.addWorksheet('Пэйж');
      ws.columns = [{ header: r.by === 'operator' ? 'Оператор' : r.by === 'day' ? 'Өдөр' : 'Пэйж', key: 'label', width: 28 }, { header: 'Захиалга', key: 'created', width: 12 }, { header: 'Баталгаажсан', key: 'confirmed', width: 14 }, { header: 'Цуцлагдсан', key: 'cancelled', width: 12 }, { header: 'Хүргэсэн', key: 'delivered', width: 12 }];
      ws.getRow(1).font = { bold: true };
      r.rows.forEach((x) => ws.addRow(x));
      ws.addRow({ label: 'Нийт', ...r.total }).font = { bold: true };
      name = `peij-${r.from}-${r.to}`;
    }
    const buf = await wb.xlsx.writeBuffer();
    return new Response(buf, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}.xlsx"`, 'Cache-Control': 'no-store' } });
  } catch (e) { return errorResponse(e); }
}
