import './globals.css';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { brandText, getBrand, logoUrl } from '@/lib/services/brand';

// #177: нэр, лого Тохиргооноос (компани бүр өөрийнх) — хуудсын гарчиг «Хуудас · Нэр•»
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  const b = await getBrand();
  const t = brandText(b);
  const icon = logoUrl(b, 64);
  return {
    title: { template: `%s · ${t}`, default: `${t} ERP` }, description: 'Захиалгын систем',
    icons: icon ? { icon: [{ url: icon, type: 'image/png' }], apple: logoUrl(b, 180)! } : { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }] },
  };
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#16181D' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const t = cookies().get('theme')?.value;
  const theme = t === 'light' || t === 'dark' ? t : undefined;
  return (
    <html lang="mn" data-theme={theme}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
