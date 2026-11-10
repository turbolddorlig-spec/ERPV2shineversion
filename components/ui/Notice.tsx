import clsx from 'clsx';
import type { ReactNode } from 'react';

export function Notice({ tone = 'bad', children }: { tone?: 'bad' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={clsx('rounded-xl px-3.5 py-3 text-[13.5px] font-medium',
      tone === 'bad' && 'bg-bad-soft text-bad-ink', tone === 'ok' && 'bg-ok-soft text-ok-ink',
      tone === 'warn' && 'bg-warn-soft text-warn', tone === 'info' && 'bg-info-soft text-info')}>
      {children}
    </div>
  );
}
