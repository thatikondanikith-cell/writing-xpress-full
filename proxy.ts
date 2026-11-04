import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSession, hasWriterSession } from '@/lib/auth';

export function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // Next serves files under public/ as static assets. Keep legacy uploads
    // reachable only through the authorized /api/files route.
    if (pathname === '/uploads' || pathname.startsWith('/uploads/')) {
        return new NextResponse(null, { status: 404 });
    }

    // Keep the admin login page public, even if session configuration is unavailable.
    if (pathname === '/admin/login') {
        return NextResponse.next();
    }

    if (pathname === '/writer/login' || pathname === '/writer/signup') {
        return NextResponse.next();
    }

    const session = getSession(request);

    // Protect user dashboard
    if (pathname.startsWith('/user/dashboard') && session?.role !== 'user') {
        return NextResponse.redirect(new URL('/user/login', request.url));
    }

    // Protect admin routes
    if (
        pathname.startsWith('/admin') &&
        session?.role !== 'admin'
    ) {
        return NextResponse.redirect(new URL('/admin/login', request.url));
    }

    if (pathname.startsWith('/writer') && (!session || !hasWriterSession(session))) {
        return NextResponse.redirect(new URL('/writer/login', request.url));
    }

    return NextResponse.next();
}

export const config = {
    matcher: ['/user/dashboard/:path*', '/admin/:path*', '/uploads/:path*', '/writer/:path*'],
};
