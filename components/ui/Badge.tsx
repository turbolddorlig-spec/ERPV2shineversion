import clsx from 'clsx';
import type { ReactNode } from 'react';

type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface2 text-muted border border-line',
  ok: 'bg-ok-soft text-ok-ink',
  bad: 'bg-bad-soft text-bad-ink',
  warn: 'bg-warn-soft text-warn',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent-ink',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2 py-0.5 text-[12px] font-bold', tones[tone], className)}>{children}</span>;
}
