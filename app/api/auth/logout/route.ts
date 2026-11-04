import { NextResponse } from 'next/server';
import { clearSessionCookies } from '@/lib/auth';

export async function POST() {
    const response = NextResponse.json({ success: true });
    clearSessionCookies(response);
    return response;
}
