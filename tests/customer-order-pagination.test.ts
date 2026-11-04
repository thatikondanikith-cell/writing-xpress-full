import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
    findFilters: [] as Array<Record<string, any>>,
    countFilter: undefined as Record<string, any> | undefined,
    aggregateFilter: undefined as Record<string, any> | undefined,
    pageDocs: [] as Array<Record<string, any>>,
    pendingDocs: [] as Array<Record<string, any>>,
    totalCount: 0,
    aggregateResult: [] as Array<{ _id: string; count: number }>,
    limit: undefined as number | undefined,
}));

vi.mock('@/lib/auth', () => ({
    getSession: () => ({ sub: '507f1f77bcf86cd799439011', role: 'user', email: 'owner@example.test' }),
    createDeliveryDownloadToken: (_session: unknown, orderId: string, fileId: string) => `token:${orderId}:${fileId}`,
}));
vi.mock('@/lib/mongoose', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/Order', () => ({
    default: {
        find: (filter: Record<string, any>) => {
            state.findFilters.push(filter);
            let projection = '';
            const query = {
                select: (value: string) => { projection = value; return query; },
                sort: () => query,
                skip: () => query,
                limit: (value: number) => { state.limit = value; return query; },
                lean: async () => projection.startsWith('orderId deliveryFile') ? state.pendingDocs : state.pageDocs,
            };
            return query;
        },
        countDocuments: async (filter: Record<string, any>) => { state.countFilter = filter; return state.totalCount; },
        aggregate: async (pipeline: Array<Record<string, any>>) => {
            state.aggregateFilter = pipeline[0]?.$match;
            return state.aggregateResult;
        },
    },
}));

import { GET } from '@/app/api/user/orders/route';

const pageOrder = {
    orderId: 'WX-20261102-0001', createdDate: '2026-11-02T10:00:00.000Z', orderStatus: 'Completed',
    physicalDeliveryStatus: 'Pending', collegeName: 'Example College', branch: 'CS', yearOfStudying: '3',
    priceAmount: 100, instructions: 'Write report', deliveryFile: 'file-page',
    completedByWriterId: 'writer-id', completedAssignmentVersion: 1, customerReview: null,
};

function request(url: string) {
    return new NextRequest(`http://localhost/api/user/orders${url}`);
}

describe('customer order pagination', () => {
    beforeEach(() => {
        state.findFilters = [];
        state.countFilter = undefined;
        state.aggregateFilter = undefined;
        state.pageDocs = [pageOrder];
        state.pendingDocs = [
            { orderId: 'WX-20261102-0001', deliveryFile: 'file-one', completedAssignmentVersion: 1, customerReview: null },
            { orderId: 'WX-20261101-0001', deliveryFile: 'file-two', completedAssignmentVersion: 2, customerReview: null },
            { orderId: 'WX-20261031-0001', deliveryFile: 'file-rated', completedAssignmentVersion: 3, customerReview: { rating: 5 } },
            { orderId: 'WX-20261030-0001', deliveryFile: 'file-invalid-version', completedAssignmentVersion: 1.5, customerReview: null },
        ];
        state.totalCount = 21;
        state.aggregateResult = [
            { _id: 'Submitted', count: 4 },
            { _id: 'In Progress', count: 7 },
            { _id: 'Completed', count: 10 },
        ];
        state.limit = undefined;
    });

    it('keeps the legacy array response when no dashboard parameters are supplied', async () => {
        const response = await GET(request('?email=attacker@example.test'));
        const body = await response.json();
        expect(Array.isArray(body)).toBe(true);
    });

    it('applies owner, search, status, local month, and pagination together while returning global stats and all pending ratings', async () => {
        const response = await GET(request('?email=attacker@example.test&page=2&limit=5&search=wx-2026&status=Completed&month=10&timeZone=Asia%2FCalcutta'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ page: 2, limit: 5, totalCount: 21, totalPages: 5 });
        expect(body.summary).toEqual({ total: 21, submitted: 4, inProgress: 7, completed: 10 });
        expect(body.orders).toHaveLength(1);
        expect(body.pendingRatings).toEqual([
            { orderId: 'WX-20261102-0001', deliveryFile: 'file-one', deliveryDownloadToken: 'token:WX-20261102-0001:file-one' },
            { orderId: 'WX-20261101-0001', deliveryFile: 'file-two', deliveryDownloadToken: 'token:WX-20261101-0001:file-two' },
        ]);
        expect(state.limit).toBe(5);
        expect(state.findFilters).toHaveLength(2);
        const legacyOwner = { ownerEmail: { $exists: false }, email: 'owner@example.test' };
        expect(state.findFilters[0].$or).toEqual([{ ownerEmail: 'owner@example.test' }, legacyOwner]);
        expect(state.countFilter?.$or).toEqual([{ ownerEmail: 'owner@example.test' }, legacyOwner]);
        expect(state.aggregateFilter?.$or).toEqual([{ ownerEmail: 'owner@example.test' }, legacyOwner]);
        expect(state.findFilters[0].orderStatus).toBe('Completed');
        expect(state.findFilters[0].orderId).toEqual({ $regex: 'wx-2026', $options: 'i' });
        expect(state.findFilters[0].$expr).toEqual({
            $eq: [
                { $month: { date: { $dateFromString: { dateString: '$createdDate' } }, timezone: 'Asia/Calcutta' } },
                11,
            ],
        });
        expect(state.findFilters[1]).toMatchObject({ $or: [{ ownerEmail: 'owner@example.test' }, legacyOwner], orderStatus: 'Completed' });
    });

    it('caps page size and rejects invalid pagination or month values', async () => {
        const capped = await GET(request('?page=1&limit=500'));
        expect(capped.status).toBe(200);
        expect(state.limit).toBe(50);

        const invalidPage = await GET(request('?page=0&limit=5'));
        const invalidMonth = await GET(request('?page=1&limit=5&month=12'));
        expect(invalidPage.status).toBe(400);
        expect(invalidMonth.status).toBe(400);
    });
});
