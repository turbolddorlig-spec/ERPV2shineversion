import type { Config } from 'tailwindcss';

const v = (name: string) => `var(--${name})`;

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), surface: v('surface'), surface2: v('surface2'), lane: v('lane'), line: v('line'),
        ink: v('ink'), 'on-ink': v('on-ink'), muted: v('muted'), subtle: v('subtle'),
        accent: v('accent'), 'on-accent': v('on-accent'), 'accent-soft': v('accent-soft'), 'accent-ink': v('accent-ink'),
        ok: v('ok'), 'ok-soft': v('ok-soft'), 'ok-ink': v('ok-ink'),
        bad: v('bad'), 'bad-soft': v('bad-soft'), 'bad-ink': v('bad-ink'),
        warn: v('warn-ink'), 'warn-soft': v('warn-soft'),
        info: v('info-ink'), 'info-soft': v('info-soft'),
        rail: v('rail'), 'rail-active': v('rail-active'), 'rail-text': v('rail-text'),
      },
      fontFamily: { sans: ['Onest', 'Inter', 'system-ui', 'sans-serif'] },
      boxShadow: { card: v('shadow'), pop: v('shadow-lg') },
      borderRadius: { xl2: '14px' },
    },
  },
  plugins: [],
} satisfies Config;
