import { NextResponse, type NextRequest } from 'next/server';

/**
 * Зөвхөн хурдан чиглүүлэлт: cookie байхгүй бол нэвтрэх хуудас руу.
 * Жинхэнэ шалгалт (токен хүчинтэй эсэх, эрх) СЕРВЕР талд хүсэлт бүрт хийгдэнэ.
 */
const PUBLIC = ['/login', '/api/auth/login', '/api/health'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p)) return NextResponse.next();
  if (req.cookies.get('zs')) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Нэвтрэх шаардлагатай', code: 'unauthorized' }, { status: 401 });
  }
  // Хэрэглэгчийн орсон хаяг (IP эсвэл домэйн) хэвээр үлдэнэ — серверийн дотоод нэр (localhost) руу биш
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  const proto = (req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '')).split(',')[0]!.trim();
  return NextResponse.redirect(new URL('/login', `${proto}://${host}`), 307);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)'],
};
