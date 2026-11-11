import { OfficeLogout } from './OfficeLogout';

export const metadata = { title: 'Зөвхөн ажлын байрнаас · zahialga•' };

/** «Зөвхөн ажлын байрнаас» (#86): ажлын интернэтээс гадуур байгаа хязгаарлагдсан ажилтанд */
export default function OfficeOnly() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-[440px] text-center">
        <p className="text-[13px] font-bold uppercase tracking-[0.07em] text-subtle">Хандах боломжгүй</p>
        <h1 className="mt-2 text-[24px] font-extrabold">Та зөвхөн ажлын байрнаас нэвтэрнэ</h1>
        <p className="mt-2 text-[14px] text-muted">Ажлын интернэтэд (Wi-Fi / сүлжээнд) холбогдсоны дараа дахин орно уу. Асуудал байвал админдаа хандана уу.</p>
        <OfficeLogout />
      </div>
    </main>
  );
}
