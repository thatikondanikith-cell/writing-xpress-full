import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        return NextResponse.json(
            { user: session ? { role: session.role } : null },
            { headers: { 'Cache-Control': 'private, no-store' } }
        );
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 503 });
        }
        console.error('Session lookup error:', error);
        return NextResponse.json({ error: 'Could not verify session' }, { status: 500 });
    }
}
