'use client';

/** Аудит А10: үндсэн layout-ын түвшний алдаа (бүх хуудас унавал) — энгийн Монгол хуудас */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="mn">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f6f6f4', color: '#1c1c1a' }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ maxWidth: 440, textAlign: 'center' }}>
            <h1 style={{ fontSize: 22, fontWeight: 800 }}>Систем түр ажиллахгүй байна</h1>
            <p style={{ fontSize: 14, color: '#666' }}>Хэдэн секундийн дараа дахин оролдоно уу. Давтагдвал админд хандана уу.</p>
            <button type="button" onClick={reset} style={{ height: 44, padding: '0 20px', borderRadius: 12, border: 0, background: '#1c1c1a', color: '#fff', fontWeight: 700 }}>Дахин оролдох</button>
          </div>
        </main>
      </body>
    </html>
  );
}
