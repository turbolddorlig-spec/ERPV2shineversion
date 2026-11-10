import clsx from 'clsx';
import type { InputHTMLAttributes, ReactNode } from 'react';

export function Field({
  label, error, hint, id, className, ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: ReactNode; id: string }) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-muted">{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        {...rest}
        className={clsx(
          'h-12 rounded-xl border bg-surface px-3.5 text-ink outline-none transition-colors md:h-11',
          'placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent-soft',
          error ? 'border-bad' : 'border-line',
        )}
      />
      {error ? <p id={`${id}-err`} className="text-[12.5px] font-medium text-bad-ink">{error}</p> : hint ? <p className="text-[12.5px] text-subtle">{hint}</p> : null}
    </div>
  );
}
