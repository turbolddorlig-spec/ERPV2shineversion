const PATHS: Record<string, string> = {
  chart: 'M4 19V9M10 19V5M16 19v-7M22 19H2',
  flow: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
  bank: 'M3 21h18M5 21V10M19 21V10M9 21V10M15 21V10M2 10l10-6 10 6',
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  warehouse: 'M3 21V9l9-5 9 5v12M7 21v-8h10v8M7 17h10',
  swap: 'M7 7h13l-3-3M17 17H4l3 3',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  truck: 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  alert: 'M12 3l10 18H2L12 3zM12 10v4M12 17.5v.5',
  calc: 'M3 7h18v12H3zM3 11h18M7 15h3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM12 8v5M12 16v.5',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H3V7zM3 7l12-4v4M16 14h2',
  store: 'M3 9l2-5h14l2 5M3 9v11h18V9M3 9h18M9 20v-6h6v6',
  file: 'M14 3H6v18h12V7l-4-4zM12 10v4M12 17v.5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21v-1a7 7 0 0 1 14 0v1',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 8v4l3 2',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1 1 0 1 0 0-.01',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  close: 'M6 6l12 12M18 6L6 18',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  logout: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12l5 5L20 7',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
};

export function Icon({ name, size = 18, className, strokeWidth = 1.9 }: { name: string; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={PATHS[name] ?? PATHS.file} />
    </svg>
  );
}
