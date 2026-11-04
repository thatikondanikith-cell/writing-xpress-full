import { NextRequest, NextResponse } from 'next/server';
import { createToken, setSessionCookie, verifyPassword } from '@/lib/auth';

export async function POST(request: NextRequest) {
    try {
        const configuredUsername = process.env.ADMIN_USERNAME?.trim();
        const configuredPasswordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
        if (!configuredUsername || !configuredPasswordHash) {
            return NextResponse.json({ error: 'Admin authentication is not configured' }, { status: 503 });
        }

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
        }

        const { username, password } = body as Record<string, unknown>;
        if (typeof username !== 'string' || typeof password !== 'string') {
            return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
        }

        if (username === configuredUsername && await verifyPassword(password, configuredPasswordHash)) {
            const token = createToken({
                sub: 'admin',
                username: configuredUsername,
                role: 'admin',
            });
            const response = NextResponse.json({
                success: true,
                message: 'Login successful'
            });
            setSessionCookie(response, token);
            return response;
        }

        return NextResponse.json(
            { error: 'Invalid credentials' },
            { status: 401 }
        );

    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service is not configured' }, { status: 503 });
        }
        console.error('Admin login failed');
        return NextResponse.json(
            { error: 'Login failed' },
            { status: 500 }
        );
    }
}
