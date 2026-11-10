'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../icons';

/** Гар утсанд доороос гарч ирдэг, компьютерт голд гардаг цонх */
export function Modal({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      aria-label={title}
      className="m-0 mt-auto w-full max-w-none rounded-t-[22px] border border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-black/50 md:m-auto md:max-w-[520px] md:rounded-[18px]"
    >
      {open ? (
        <div className="flex max-h-[88vh] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <h2 className="text-[17px] font-extrabold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Хаах" className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface2">
              <Icon name="close" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
