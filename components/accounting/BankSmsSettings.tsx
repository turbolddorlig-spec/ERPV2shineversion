'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/Notice';
import { api, ApiError } from '@/components/ui/api';
import { ubDateTime } from '@/lib/format';

interface D { accounts: string[]; url: string | null; lastAt: string | null; count: number; lastResult: string | null; rejected: number; lastRejectedAt: string | null }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

/** #181 Банкны орлого утаснаас шууд (MacroDroid) + дансны шүүлтүүр — зөвхөн Супер админ */
export function BankSmsSettings() {
  const [d, setD] = useState<D | null>(null);
  const [acc, setAcc] = useState('');
  const [show, setShow] = useState(false);
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const apply = (r: D) => { setD(r); setAcc(r.accounts.join(', ')); };
  const load = useCallback(() => api<D>('/api/settings/bank-sms').then(apply).catch((e) => setErr(msg(e))), []);
  useEffect(() => { void load(); }, [load]);
  async function call(key: string, json: Record<string, unknown>, m: string) {
    setBusy(key); setErr(null); setOk(null);
    try { apply(await api<D>('/api/settings/bank-sms', { method: 'POST', json })); setOk(m); } catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  }
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); setOk('Хуулагдлаа'); } catch { /* */ } };
  if (!d) return err ? <Notice>{err}</Notice> : null;
  const masked = d.url ? d.url.replace(/key=.*/, 'key=••••••••••••') : '';
  return (
    <div data-bank-sms className="flex min-w-0 flex-col gap-3 border-t border-line pt-3">
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {/* Дансны шүүлтүүр — Gmail ба утсанд хоёуланд */}
      <div className="flex flex-col gap-1.5">
        <b className="text-[14px]">Орлого хүлээн авах данс (сүүлийн 4 орон)</b>
        <p className="text-[12.5px] text-subtle">Зөвхөн эдгээр дансны «ORLOGO» мессеж Банкны импортод орно (Gmail ба утас хоёуланд). Хоосон бол бүх данс. Данс солигдвол энд л сольно. Олон данс бол таслалаар: 4242, 8385</p>
        <div className="flex flex-wrap gap-2">
          <input data-bank-accounts value={acc} onChange={(e) => setAcc(e.target.value)} placeholder="жишээ: 4242" inputMode="numeric" className="h-11 min-w-[160px] flex-1 rounded-xl border border-line bg-surface px-3 text-[15px]" />
          <Button loading={busy === 'acc'} onClick={() => call('acc', { kind: 'accounts', accounts: acc }, acc.trim() ? `Хадгаллаа — зөвхөн ${acc} дансны орлого` : 'Хадгаллаа — бүх данс')}>Хадгалах</Button>
        </div>
      </div>
      {/* Утаснаас шууд */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2"><b className="text-[14px]">Утаснаас шууд (MacroDroid)</b>{d.url ? <Badge tone="ok">Идэвхтэй</Badge> : <Badge>Идэвхгүй</Badge>}</div>
        <p className="text-[12.5px] text-subtle">Банкны мессеж ирмэгц утас шууд энд илгээнэ — Gmail-ээс хурдан (хэдхэн секунд). Gmail-тэй яг ижил дүрэм; хоёулаа асаалттай байсан ч нэг гүйлгээ нэг л удаа орно.</p>
        {d.url ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <code data-bank-sms-url className="min-w-0 flex-1 rounded-xl border border-line bg-surface2 px-3 py-2.5 text-[12.5px] [overflow-wrap:anywhere]">{show ? d.url : masked}</code>
            <Button size="sm" onClick={() => setShow(!show)}>{show ? 'Нуух' : 'Харах'}</Button>
            <Button size="sm" onClick={() => void copy(d.url!)}>Хуулах</Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant={d.url ? 'secondary' : 'primary'} loading={busy === 'rot'} onClick={() => { if (!d.url || confirm('Түлхүүр солих уу? Утасны MacroDroid-д шинэ хаягийг дахин тавих хэрэгтэй.')) void call('rot', { kind: 'rotate' }, d.url ? 'Түлхүүр солигдлоо — хуучин хаяг ажиллахгүй. Шинэ хаягийг MacroDroid-д тавина уу.' : 'Идэвхжлээ — хаягийг MacroDroid-д тавина уу'); }}>{d.url ? 'Түлхүүр солих' : 'Идэвхжүүлэх'}</Button>
          {d.url ? <Button variant="danger" loading={busy === 'off'} onClick={() => { if (confirm('Утаснаас хүлээн авахыг зогсоох уу? (Gmail хэвээр)')) void call('off', { kind: 'disable' }, 'Зогсоолоо'); }}>Зогсоох</Button> : null}
        </div>
        <div className="text-[12.5px] text-muted">
          {d.lastAt ? <>Сүүлд хүлээн авсан: {ubDateTime(d.lastAt)} · нийт {d.count}{d.lastResult ? <span className="block [overflow-wrap:anywhere]">Үр дүн: {d.lastResult}</span> : null}</> : 'Хараахан мессеж ирээгүй'}
          {d.rejected ? <span className="block text-warn">Буруу түлхүүртэй оролдлого: {d.rejected}{d.lastRejectedAt ? ` (сүүлд ${ubDateTime(d.lastRejectedAt)})` : ''}</span> : null}
        </div>
        <button type="button" onClick={() => setGuide(!guide)} className="self-start text-[13px] font-semibold text-muted underline">{guide ? '▾' : '▸'} MacroDroid тохируулах заавар (5 минут)</button>
        {guide ? (
          <ol className="flex list-decimal flex-col gap-1.5 rounded-xl border border-line p-3 pl-8 text-[13px] [overflow-wrap:anywhere]">
            <li>Дээрх <b>«Идэвхжүүлэх»</b> → <b>«Хуулах»</b> (хаягийг утас руугаа илгээнэ — жишээ нь өөртөө мессенжерээр).</li>
            <li>MacroDroid → <b>Add Macro</b> → Trigger: <b>SMS Received</b> → Contact/number: Хаан банкны дугаар (эсвэл «Any», мессежид «Khan Bank» агуулсан).</li>
            <li>Action: <b>Connectivity → HTTP Request</b> → Method: <b>POST</b> → URL: хуулсан хаяг.</li>
            <li>Body / Content: <b>text/plain</b> → утга нь <b>[sms_message]</b> (MacroDroid-ийн «мессежийн текст» хувьсагч).</li>
            <li>Хадгалаад туршихдаа 1₮ шилжүүлж үзнэ — энд «Сүүлд хүлээн авсан» шинэчлэгдэнэ.</li>
            <li>Утсаа алдвал / хаяг гадагш задарвал <b>«Түлхүүр солих»</b> — хуучин хаяг шууд ажиллахгүй.</li>
          </ol>
        ) : null}
      </div>
    </div>
  );
}
