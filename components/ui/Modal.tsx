'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../icons';

/** Гар утсанд доороос гарч ирдэг, компьютерт голд гардаг цонх */
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', bodyClassName }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
  /** xl: хуучин ERP-ийн том цонх (захиалга, дуудлагын бүртгэл) */
  size?: 'md' | 'xl' | 'drawer'; bodyClassName?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Хуучин ERP шиг: эхний бичих талбар руу шууд (хаах товч руу биш)
      setTimeout(() => (d.querySelector<HTMLElement>('[data-autofocus]'))?.focus(), 0);
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      aria-label={title}
      className={size === 'drawer'
        ? 'm-0 ml-auto h-full max-h-none w-full max-w-[560px] border-l border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-black/30 backdrop:backdrop-blur-[2px]'
        : size === 'xl'
        ? 'm-0 mt-auto w-full max-w-none rounded-t-[18px] border border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[3px] md:m-auto md:w-[calc(100vw-48px)] md:max-w-[1180px] md:rounded-[14px]'
        : 'm-0 mt-auto w-full max-w-none rounded-t-[22px] border border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[3px] md:m-auto md:max-w-[520px] md:rounded-[18px]'}
    >
      {open ? (
        <div className={size === 'drawer' ? 'flex h-full flex-col' : size === 'xl' ? 'flex max-h-[95vh] flex-col md:max-h-[94vh]' : 'flex max-h-[88vh] flex-col'}>
          <div className={size !== 'md' ? 'flex items-center justify-between gap-3 border-b border-line px-4 py-2.5' : 'flex items-center justify-between gap-3 border-b border-line px-5 py-4'}>
            <div className="min-w-0">
              <h2 className={size !== 'md' ? 'text-[16px] font-extrabold' : 'text-[17px] font-extrabold'}>{title}</h2>
              {subtitle ? <p className="text-[12.5px] text-muted">{subtitle}</p> : null}
            </div>
            <button type="button" onClick={onClose} aria-label="Хаах" className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-surface2">
              <Icon name="close" />
            </button>
          </div>
          <div className={bodyClassName ?? (size !== 'md' ? 'min-h-0 flex-1 overflow-y-auto px-4 py-3' : 'overflow-y-auto px-5 py-4')}>{children}</div>
          {footer ? <div className={size === 'xl' ? 'border-t border-line bg-surface2/60 px-4 py-2.5 pb-[max(10px,env(safe-area-inset-bottom))]' : 'flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))]'}>{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
