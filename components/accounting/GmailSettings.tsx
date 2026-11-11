'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { Badge } from '@/components/ui/Badge';
import { api, ApiError } from '@/components/ui/api';
import { ubDateTime } from '@/lib/format';

/**
 * Тохиргоо → Gmail (банкны мэдэгдэл): Gmail хаяг + 16 оронтой App Password → «Хадгалаад Sync» дармагц холбогдож Хаан банкны гүйлгээг татна.
 * Нууц үг серверт шифрлэгдэж хадгалагдана, дахин харагдахгүй (хоосон үлдээвэл хуучнаараа).
 */
interface S { email: string; hasPassword: boolean; sender: string; autoSync: boolean; minutes: number; days: number; lastSyncAt: string | null; lastResult: string | null; lastOk: boolean | null }
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Алдаа гарлаа');

export function GmailSettings({ onSynced }: { onSynced?: () => void }) {
  const [s, setS] = useState<S | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [f, setF] = useState({ email: '', appPassword: '', sender: '', autoSync: true, minutes: '5', days: '3' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ settings: S; canEdit: boolean }>('/api/bank/gmail');
      setS(r.settings); setCanEdit(r.canEdit);
      setF((x) => ({ ...x, email: r.settings.email, sender: r.settings.sender, autoSync: r.settings.autoSync, minutes: String(r.settings.minutes), days: String(r.settings.days), appPassword: '' }));
    } catch (e) { setErr(msg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const saveAndSync = async () => {
    setBusy('sync'); setErr(null); setOk(null);
    try {
      await api('/api/bank/gmail', { method: 'POST', json: { action: 'settings', email: f.email, appPassword: f.appPassword, sender: f.sender, autoSync: f.autoSync, minutes: Number(f.minutes), days: Number(f.days) } });
      const r = await api<{ emails: number; imported: number; matched: number; skipped: number }>('/api/bank/gmail', { method: 'POST', json: { action: 'sync' } });
      setOk(`✓ Холбогдлоо: ${r.emails} имэйл уншиж ${r.imported} шинэ гүйлгээ импортлов, ${r.matched} захиалга «Мөнгө орсон» боллоо`);
      onSynced?.();
    } catch (e) { setErr(msg(e)); } finally { setBusy(null); await load(); }
  };
  const disconnect = async () => {
    setBusy('off'); setErr(null); setOk(null);
    try { await api('/api/bank/gmail', { method: 'POST', json: { action: 'disconnect' } }); setOk('Gmail салгагдлаа'); } catch (e) { setErr(msg(e)); } finally { setBusy(null); await load(); }
  };
  if (!s) return err ? <Notice>{err}</Notice> : <p className="text-muted">Ачаалж байна…</p>;
  const connected = s.hasPassword && s.lastOk === true;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {connected ? <Badge tone="ok">✓ Холбогдсон</Badge> : s.hasPassword && s.lastOk === false ? <Badge tone="bad">Холболт амжилтгүй</Badge> : s.hasPassword ? <Badge tone="warn">Хадгалсан — Sync дарна уу</Badge> : <Badge>Холбогдоогүй</Badge>}
        {s.lastSyncAt ? <span className="min-w-0 text-[12.5px] text-subtle [overflow-wrap:anywhere]">Сүүлд {ubDateTime(s.lastSyncAt)}: {s.lastResult}</span> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="gm-email" label="Gmail хаяг" type="email" autoComplete="off" placeholder="tanii.ner@gmail.com" value={f.email} disabled={!canEdit} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Field id="gm-pass" label="App Password (16 үсэг)" type="password" autoComplete="new-password" placeholder={s.hasPassword ? '•••• хадгалсан (солих бол бичнэ)' : 'abcd efgh ijkl mnop'} value={f.appPassword} disabled={!canEdit} onChange={(e) => setF({ ...f, appPassword: e.target.value })} />
        <Field id="gm-sender" label="Хаан банкны илгээгч (заавал биш)" placeholder="Хоосон бол бүх имэйлээс хайна" value={f.sender} disabled={!canEdit} onChange={(e) => setF({ ...f, sender: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <Field id="gm-days" label="Хэдэн хоногийн" inputMode="numeric" value={f.days} disabled={!canEdit} onChange={(e) => setF({ ...f, days: e.target.value.replace(/\D/g, '') })} />
          <Field id="gm-min" label="Давтамж (минут)" inputMode="numeric" value={f.minutes} disabled={!canEdit} onChange={(e) => setF({ ...f, minutes: e.target.value.replace(/\D/g, '') })} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[14px] font-semibold"><input type="checkbox" className="h-5 w-5" checked={f.autoSync} disabled={!canEdit} onChange={(e) => setF({ ...f, autoSync: e.target.checked })} />Автоматаар татах ({f.minutes || 5} минут тутам)</label>
      {err ? <Notice>{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === 'sync'} onClick={() => void saveAndSync()}>Хадгалаад Sync</Button>
          {s.hasPassword ? <Button variant="danger" loading={busy === 'off'} onClick={() => void disconnect()}>Салгах</Button> : null}
        </div>
      ) : null}
      <details className="text-[12.5px] text-muted">
        <summary className="cursor-pointer font-semibold">App Password хэрхэн авах вэ?</summary>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>Gmail-ээ нээж, баруун дээд буланд зураг дээрээ дарж <b>«Google бүртгэлээ удирдах»</b> гэж орно.</li>
          <li><b>«Аюулгүй байдал»</b> → <b>«2 шаттай баталгаажуулалт»</b>-ыг асаана (асаалттай бол алгасна).</li>
          <li>Дээрх хайлтад <b>«App passwords»</b> (Апп-ын нууц үг) гэж бичээд орно.</li>
          <li>Нэр нь жишээ нь «zahialga» гэж бичээд <b>«Create»</b> дарна — 16 үсэгтэй нууц үг гарна.</li>
          <li>Тэр 16 үсгийг энд «App Password» талбарт хуулж бичээд <b>«Хадгалаад Sync»</b> дарна.</li>
        </ol>
        <p className="mt-1">Нууц үг серверт шифрлэгдэж хадгалагдана, хэнд ч дахин харагдахгүй. Хаан банкны мэдэгдэл (SMS/имэйл) энэ Gmail-д ирдэг байх ёстой.</p>
      </details>
    </div>
  );
}
