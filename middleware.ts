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
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)'],
};
