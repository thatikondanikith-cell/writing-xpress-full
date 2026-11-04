import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredFiles } from '@/lib/file-retention';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return NextResponse.json({ error: 'Cron authentication is not configured' }, { status: 503 });
    }
    const suppliedBuffer = Buffer.from(request.headers.get('authorization') || '');
    const expectedBuffer = Buffer.from(`Bearer ${secret}`);
    if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = await cleanupExpiredFiles();
        console.info('File retention cleanup completed', result);
        if (result.failures > 0) {
            return NextResponse.json({ error: 'Some expired files could not be cleaned up', ...result }, { status: 500 });
        }
        return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
        console.error('File retention cleanup failed');
        return NextResponse.json({ error: 'Could not clean up expired files' }, { status: 500 });
    }
}
