import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
    session: null as { role: string } | null,
    aggregate: vi.fn(),
    connectDB: vi.fn(async () => undefined),
}));

vi.mock('@/lib/auth', () => ({ getSession: () => state.session }));
vi.mock('@/lib/mongoose', () => ({ connectDB: state.connectDB }));
vi.mock('@/lib/models/Order', () => ({ default: { aggregate: state.aggregate } }));

import { GET } from '@/app/api/admin/analytics/route';

const periodQuery = new URLSearchParams({
    rangeStart: '2025-12-01T00:00:00.000Z',
    currentMonthStart: '2026-11-01T00:00:00.000Z',
    rangeEnd: '2026-12-01T00:00:00.000Z',
    timeZone: 'UTC',
});

function request(query = periodQuery) {
    return new NextRequest(`http://localhost/api/admin/analytics?${query.toString()}`);
}

describe('admin analytics API', () => {
    it('rejects unauthenticated and non-admin requests before querying orders', async () => {
        state.session = null;
        state.aggregate.mockClear();
        const unauthenticated = await GET(request());
        expect(unauthenticated.status).toBe(401);

        state.session = { role: 'writer' };
        const writer = await GET(request());
        expect(writer.status).toBe(403);
        expect(state.aggregate).not.toHaveBeenCalled();
    });

    it('returns compact metrics and chart series for admins only', async () => {
        state.session = { role: 'admin' };
        state.aggregate.mockResolvedValueOnce([{
            metrics: [{ totalRevenue: 975, completedRevenue: 750, pendingRevenue: 225, thisMonthRevenue: 250 }],
            monthlyRevenue: [{ month: '2026-11', revenue: 250, orderCount: 1 }],
            orderStatistics: [{ _id: 'Submitted', count: 3 }, { _id: 'Completed', count: 2 }],
        }]);

        const response = await GET(request());
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        await expect(response.json()).resolves.toEqual({
            metrics: { totalRevenue: 975, completedRevenue: 750, pendingRevenue: 225, thisMonthRevenue: 250 },
            monthlyRevenue: [{ month: '2026-11', revenue: 250, orderCount: 1 }],
            orderStatistics: [
                { status: 'Submitted', count: 3 },
                { status: 'In Progress', count: 0 },
                { status: 'Completed', count: 2 },
            ],
        });

        const pipeline = state.aggregate.mock.calls[0][0];
        expect(pipeline[0].$addFields.__analyticsRevenue.$convert).toMatchObject({ onError: 0, onNull: 0 });
        expect(pipeline[1].$facet.monthlyRevenue[1].$group._id.$dateToString.timezone).toBe('UTC');
    });

    it('rejects malformed or excessively wide periods', async () => {
        state.session = { role: 'admin' };
        state.aggregate.mockClear();
        const invalid = new URLSearchParams(periodQuery);
        invalid.set('timeZone', 'Invalid/Zone');
        expect((await GET(request(invalid))).status).toBe(400);
        expect(state.aggregate).not.toHaveBeenCalled();
    });
});
