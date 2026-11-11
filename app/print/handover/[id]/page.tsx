import { notFound } from 'next/navigation';
import { requirePage } from '@/lib/current-user';
import { handoverDetail } from '@/lib/services/delivery/handover';
import { money, ubDateTime } from '@/lib/format';
import { PrintButton } from './PrintButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Падаан · zahialga•' };

const mmdd = (d: Date | null) => (d ? `${new Date(d.getTime() + 8 * 3600_000).getUTCMonth() + 1} сарын ${new Date(d.getTime() + 8 * 3600_000).getUTCDate()}-нд үүссэн` : '');

/** Падаан хэвлэх — хуучин шиг: огноо, жолооч, нийт захиалга, нийт дүн; захиалга бүрийн бараа (үйлчлүүлэгчийн мэдээлэлгүй); баталгаа */
export default async function HandoverPrintPage({ params }: { params: { id: string } }) {
  const { user } = await requirePage('handover');
  const h = await handoverDetail({ id: user.id, name: user.name, roles: user.roles }, Number(params.id)).catch(() => null);
  if (!h) notFound();
  const orders = h.orders.filter((o) => !o.removedAt);
  return (
    <main className="mx-auto max-w-[820px] bg-white p-6 text-[13px] text-black [overflow-wrap:anywhere] print:p-0">
      <div className="mb-4 flex items-start justify-between print:hidden"><a href="/handover" className="text-[13px] underline">← Буцах</a><PrintButton /></div>
      <h1 className="text-[20px] font-extrabold">Падаан {h.number}</h1>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 border-y border-black/20 py-2 sm:grid-cols-4">
        <p>Огноо: <b>{h.date}</b></p><p>Жолооч: <b>{h.driverName}</b></p><p>Нийт захиалга: <b>{orders.length}</b></p><p>Нийт дүн: <b>{money(h.totals.amount)}</b></p>
      </div>
      <h2 className="mt-4 font-bold">Барааны нэгтгэл ({h.totals.pieces} ширхэг)</h2>
      <table className="mt-1 w-full border-collapse text-[12.5px]">
        <thead><tr className="border-b border-black/30 text-left"><th className="py-1">Тавиур</th><th>Бараа</th><th className="text-right">Тоо</th><th className="text-center">Check</th></tr></thead>
        <tbody>{h.items.map((i) => <tr key={i.variantId} className="border-b border-black/10"><td className="py-1">{i.shelfCode ?? ''}</td><td>{i.code} · {i.name}{i.label ? ` · ${i.label}` : ''}</td><td className="text-right font-bold">{i.qty}</td><td className="text-center">{i.checked ? '✓' : '☐'}</td></tr>)}</tbody>
      </table>
      {h.extras.length ? (<>
        <h2 className="mt-4 font-bold">Нэмэлт бараа — жолоочийн хүсэлт ({h.totals.extraPieces} ширхэг · {money(h.totals.extraAmount)})</h2>
        <table className="mt-1 w-full border-collapse text-[12.5px]">
          <tbody>{h.extras.map((i) => <tr key={i.variantId} className="border-b border-black/10"><td className="py-1">{i.shelfCode ?? ''}</td><td>{i.code} · {i.name}{i.label ? ` · ${i.label}` : ''}</td><td className="text-right font-bold">{i.qty}</td><td className="text-center">{i.checked ? '✓' : '☐'}</td></tr>)}</tbody>
        </table>
      </>) : null}
      <h2 className="mt-4 font-bold">Захиалгууд</h2>
      <div className="mt-1 grid gap-2 sm:grid-cols-2 print:grid-cols-2">
        {orders.map((o, i) => (
          <div key={o.orderId} className="min-w-0 break-inside-avoid rounded border border-black/20 p-2">
            <p className="flex justify-between"><b>#{i + 1} · №{o.number}</b><span>{mmdd(o.createdAt ? new Date(o.createdAt) : null)}</span></p>
            <p>Дүн: <b>{money(o.total)}</b></p>
            <p className="mt-1 font-semibold">Бараанууд:</p>
            {o.lines.map((l, j) => <p key={j}>• {l.name}{l.label ? ` · ${l.label}` : ''} {l.qty}ш — {money(l.unitPrice * l.qty)}</p>)}
            {o.note ? <p className="mt-1 font-bold text-red-700">Санамж: {o.note}</p> : null}
          </div>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="rounded border border-black/30 p-3"><p className="font-bold">Агуулах баталгаажуулсан</p><p>{h.handedOverBy ?? '________________'}</p><p className="text-[12px]">{h.handedOverAt ? ubDateTime(h.handedOverAt) : 'Огноо, гарын үсэг'}</p></div>
        <div className="rounded border border-black/30 p-3"><p className="font-bold">Жолооч хүлээн авсан</p><p>{h.driverName}</p><p className="text-[12px]">Гарын үсэг ________________</p></div>
      </div>
    </main>
  );
}
