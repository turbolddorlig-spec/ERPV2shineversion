'use client';
import { useEffect } from 'react';

/** Аудит А10: хуудсанд гэнэтийн алдаа гарвал Монгол мессеж + «Дахин оролдох» */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="max-w-[440px] text-center">
        <h1 className="text-[22px] font-extrabold">Алдаа гарлаа</h1>
        <p className="mt-2 text-[14px] text-muted">Хуудсыг ачаалж чадсангүй. Дахин оролдоно уу — давтагдвал админд хандана уу{error.digest ? ` (код: ${error.digest})` : ''}.</p>
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" onClick={reset} className="inline-flex h-11 items-center rounded-xl bg-ink px-5 font-bold text-on-ink">Дахин оролдох</button>
          <a href="/" className="inline-flex h-11 items-center rounded-xl border border-line px-5 font-bold">Нүүр хуудас</a>
        </div>
      </div>
    </main>
  );
}
