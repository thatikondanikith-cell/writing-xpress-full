import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';
import {
    buildAdminAnalyticsPipeline,
    normalizeAdminAnalyticsResult,
    type AdminAnalyticsPeriod,
} from '@/lib/admin-analytics';

const MIN_PERIOD_MS = 360 * 24 * 60 * 60 * 1000;
const MAX_PERIOD_MS = 370 * 24 * 60 * 60 * 1000;

function parseIsoDate(value: string | null): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}

function parsePeriod(request: NextRequest): AdminAnalyticsPeriod | null {
    const params = new URL(request.url).searchParams;
    const rangeStart = parseIsoDate(params.get('rangeStart'));
    const currentMonthStart = parseIsoDate(params.get('currentMonthStart'));
    const rangeEnd = parseIsoDate(params.get('rangeEnd'));
    const timeZone = params.get('timeZone') || '';

    if (!rangeStart || !currentMonthStart || !rangeEnd || timeZone.length > 100 ||
        !(rangeStart < currentMonthStart && currentMonthStart < rangeEnd)) return null;

    const duration = rangeEnd.getTime() - rangeStart.getTime();
    if (duration < MIN_PERIOD_MS || duration > MAX_PERIOD_MS) return null;

    try {
        new Intl.DateTimeFormat('en', { timeZone });
    } catch {
        return null;
    }

    return { rangeStart, currentMonthStart, rangeEnd, timeZone };
}

export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        const period = parsePeriod(request);
        if (!period) return NextResponse.json({ error: 'Invalid analytics period' }, { status: 400 });

        await connectDB();
        const [result] = await OrderModel.aggregate(buildAdminAnalyticsPipeline(period));
        return NextResponse.json(normalizeAdminAnalyticsResult(result), {
            headers: { 'Cache-Control': 'private, no-store' },
        });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Admin analytics error:', error);
        return NextResponse.json({ error: 'Could not load analytics' }, { status: 500 });
    }
}
