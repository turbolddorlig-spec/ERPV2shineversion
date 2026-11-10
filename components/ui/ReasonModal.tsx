'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Notice } from './Notice';

export const REASON_MIN = 5;
export const reasonOk = (s: string) => s.replace(/\s/g, '').length >= REASON_MIN;

/**
 * Засварын тайлбар асуух цонх (шийдвэр #29).
 * Тайлбаргүй хадгалахыг оролдоход гарч ирнэ; хийсэн өөрчлөлт алдагдахгүй.
 */
export function ReasonModal({ open, title = 'Засварын тайлбар бичнэ үү', summary, onCancel, onConfirm, busy, error }: {
  open: boolean; title?: string; summary?: React.ReactNode; busy?: boolean; error?: string | null;
  onCancel: () => void; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setReason(''); setTouched(false); setTimeout(() => ref.current?.focus(), 50); } }, [open]);
  const ok = reasonOk(reason);
  const submit = () => { setTouched(true); if (ok && !busy) onConfirm(reason.trim()); };
  return (
    <Modal open={open} onClose={onCancel} title={title}
      footer={<><Button onClick={onCancel}>Болих</Button><Button variant="primary" loading={busy} onClick={submit}>Хадгалах</Button></>}>
      <div className="flex flex-col gap-3">
        {summary ? <div className="rounded-xl bg-surface2 px-3 py-2.5 text-[13.5px] text-muted">{summary}</div> : null}
        <label htmlFor="reason" className="text-[13px] font-semibold text-muted">Яагаад өөрчилж байгаа вэ? (дор хаяж {REASON_MIN} тэмдэгт)</label>
        <textarea id="reason" ref={ref} rows={3} value={reason} maxLength={500}
          onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
          placeholder="Жишээ: Нийлүүлэгч үнэ өсгөсөн"
          aria-invalid={touched && !ok ? true : undefined}
          className={`rounded-xl border bg-surface px-3.5 py-3 text-ink outline-none focus:border-accent ${touched && !ok ? 'border-bad' : 'border-line'}`} />
        {touched && !ok ? <p className="text-[12.5px] font-medium text-bad-ink">Тайлбар дор хаяж {REASON_MIN} тэмдэгт байх ёстой</p> : null}
        {error ? <Notice>{error}</Notice> : null}
        <p className="text-[12px] text-subtle">Тайлбар таны нэртэй хамт «Барааны засвар» хуудсанд бүгдэд харагдана.</p>
      </div>
    </Modal>
  );
}
