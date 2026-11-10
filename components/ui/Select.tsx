import clsx from 'clsx';
import type { SelectHTMLAttributes } from 'react';

export function Select({ label, id, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; id: string }) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      {label ? <label htmlFor={id} className="text-[13px] font-semibold text-muted">{label}</label> : null}
      <select id={id} {...rest} className="h-12 rounded-xl border border-line bg-surface px-3 text-ink outline-none focus:border-accent disabled:opacity-60 md:h-11">
        {children}
      </select>
    </div>
  );
}
