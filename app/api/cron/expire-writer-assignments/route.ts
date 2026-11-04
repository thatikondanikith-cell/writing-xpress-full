import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { expirePendingWriterAssignments } from '@/lib/assignment-expiration';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return NextResponse.json({ error: 'Cron authentication is not configured' }, { status: 503 });
    }
    const supplied = request.headers.get('authorization') || '';
    const expected = `Bearer ${secret}`;
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = await expirePendingWriterAssignments();
        return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        console.error('Writer assignment expiration job failed:', error);
        return NextResponse.json({ error: 'Could not expire pending writer assignments' }, { status: 500 });
    }
}
