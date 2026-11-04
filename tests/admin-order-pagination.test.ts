import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ query: undefined as unknown }));

vi.mock('@/lib/auth', () => ({ getSession: () => ({ sub: 'admin-id', role: 'admin' }) }));
vi.mock('@/lib/email', () => ({ sendWorkflowEmail: vi.fn() }));
vi.mock('@/lib/db', () => ({
    createOrder: vi.fn(),
    getAllOrders: async () => [{ orderId: 'WX-20261102-0001', orderStatus: 'Submitted' }],
    getAdminOrderDashboardPage: async (query: { page: number; limit: number }) => {
        state.query = query;
        return {
            orders: [{ orderId: 'WX-20261102-0001', orderStatus: 'Submitted' }],
            totalCount: 1,
            page: query.page,
            limit: query.limit,
            summary: { total: 1, submitted: 1, inProgress: 0, completed: 0 },
            unassignedOrders: [],
        };
    },
    InvalidOrderFileReferencesError: class InvalidOrderFileReferencesError extends Error {},
}));

import { GET } from '@/app/api/orders/route';

describe('admin orders listing compatibility', () => {
    it('keeps the unparameterized array response used by analytics', async () => {
        const response = await GET(new NextRequest('http://localhost/api/orders'));
        const body = await response.json();

        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(1);
    });

    it('returns the paginated dashboard response and forwards search and filters', async () => {
        const response = await GET(new NextRequest(
            'http://localhost/api/orders?page=2&limit=10&search=sample&status=Completed&dateFrom=2026-11-01T18%3A30%3A00.000Z&dateTo=2026-11-02T18%3A30%3A00.000Z'
        ));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ totalCount: 1, page: 2, limit: 10, summary: { total: 1 }, orders: [{ orderId: 'WX-20261102-0001' }] });
        expect(state.query).toEqual({
            page: 2,
            limit: 10,
            search: 'sample',
            status: 'Completed',
            dateFrom: '2026-11-01T18:30:00.000Z',
            dateTo: '2026-11-02T18:30:00.000Z',
        });
    });

    it('rejects invalid page parameters', async () => {
        const response = await GET(new NextRequest('http://localhost/api/orders?page=0&limit=10'));
        expect(response.status).toBe(400);
    });
});
