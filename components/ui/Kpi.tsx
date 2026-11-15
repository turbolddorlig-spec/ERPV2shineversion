import clsx from 'clsx';
import type { ReactNode } from 'react';

export type KpiTone = 'page' | 'ok' | 'bad' | 'warn' | 'info' | 'neutral';
const BAR: Record<KpiTone, string> = {
  page: 'var(--page)', ok: 'var(--ok)', bad: 'var(--bad)', warn: '#D97706', info: 'var(--info-ink)', neutral: 'var(--line)',
};
const TEXT: Record<KpiTone, string | undefined> = { page: undefined, ok: 'text-ok-ink', bad: 'text-bad-ink', warn: 'text-warn', info: 'text-info', neutral: undefined };

/** «A» загварын KPI карт — дээд талдаа өнгөт зураастай */
export function Kpi({ label, value, sub, tone = 'page', className, children, ...rest }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: KpiTone; className?: string; children?: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div {...rest} className={clsx('flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface p-3.5 shadow-card', className)}
      style={{ boxShadow: `inset 0 3px 0 ${BAR[tone]}` }}>
      <span className="text-[12px] font-semibold text-muted">{label}</span>
      <b className={clsx('text-[24px] font-extrabold leading-none tracking-tight [overflow-wrap:anywhere]', TEXT[tone])}>{value}</b>
      {sub ? <span className="[overflow-wrap:anywhere] text-[11.5px] text-muted">{sub}</span> : null}
      {children}
    </div>
  );
}
