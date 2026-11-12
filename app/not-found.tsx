import Link from 'next/link';

export const metadata = { title: 'Хуудас олдсонгүй · zahialga•' };

/** Аудит А10: Монгол 404 хуудас */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="max-w-[420px] text-center">
        <p className="text-[13px] font-bold uppercase tracking-[0.07em] text-subtle">404</p>
        <h1 className="mt-2 text-[24px] font-extrabold">Хуудас олдсонгүй</h1>
        <p className="mt-2 text-[14px] text-muted">Хаяг буруу, эсвэл энэ мэдээлэл устсан байж магадгүй.</p>
        <Link href="/" className="mt-5 inline-flex h-11 items-center rounded-xl bg-ink px-5 font-bold text-on-ink">Нүүр хуудас руу</Link>
      </div>
    </main>
  );
}
