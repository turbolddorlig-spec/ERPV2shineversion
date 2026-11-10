import clsx from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger';

const styles: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent font-bold border-transparent',
  dark: 'bg-ink text-on-ink font-bold border-transparent',
  secondary: 'bg-surface text-ink font-semibold border-line hover:bg-surface2',
  ghost: 'bg-transparent text-muted font-semibold border-transparent hover:bg-surface2',
  danger: 'bg-surface text-bad-ink font-bold border-line hover:bg-bad-soft',
};

export function Button({
  variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-[11px] border transition-colors disabled:cursor-not-allowed disabled:opacity-55 whitespace-nowrap',
        size === 'sm' && 'h-9 px-3 text-[13px]',
        size === 'md' && 'h-11 px-4 text-[14px] md:h-10',
        size === 'lg' && 'h-12 px-5 text-[15px]',
        styles[variant],
        className,
      )}
    >
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
