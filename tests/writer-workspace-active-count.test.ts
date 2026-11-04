import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
    orders: [] as Array<Record<string, unknown>>,
    completedOrders: [] as Array<Record<string, unknown>>,
    completedTotalCount: 0,
    completedFilter: undefined as Record<string, any> | undefined,
    completedPipeline: [] as Array<Record<string, any>>,
    writerFilter: undefined as Record<string, unknown> | undefined,
    workloadCalls: 0,
    expirationCalls: 0,
}));

vi.mock('@/lib/auth', () => ({
    getSession: () => ({ sub: '507f1f77bcf86cd799439011', role: 'writer', email: 'writer@example.test' }),
    hasWriterSession: () => true,
}));
vi.mock('@/lib/mongoose', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/assignment-expiration', () => ({
    expirePendingWriterAssignments: async () => { state.expirationCalls += 1; },
}));
vi.mock('@/lib/models/Order', () => ({
    default: {
        find: () => ({
            select: () => ({
                sort: () => ({ lean: async () => state.orders }),
            }),
        }),
        countDocuments: async (filter: Record<string, any>) => {
            state.completedFilter = filter;
            return state.completedTotalCount;
        },
        aggregate: async (pipeline: Array<Record<string, any>>) => {
            state.completedPipeline = pipeline;
            return state.completedOrders;
        },
    },
}));
vi.mock('@/lib/models/User', () => ({
    default: {
        findOne: (filter: Record<string, unknown>) => {
            state.writerFilter = filter;
            return { select: () => ({ lean: async () => ({ isAvailable: true, applicationStatus: 'approved' }) }) };
        },
    },
}));
vi.mock('@/lib/db', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/db')>();
    return {
        ...actual,
        getWriterWorkloads: vi.fn(async () => { state.workloadCalls += 1; return new Map(); }),
    };
});

import { GET } from '@/app/api/writer/workspace/route';
import { getWriterWorkloads } from '@/lib/db';

describe('writer workspace active order count', () => {
    it('keeps pending and active orders unpaged and returns only a page of completed history', async () => {
        state.orders = [
            { orderId: 'submitted-accepted', orderStatus: 'Submitted', assignmentStatus: 'accepted' },
            { orderId: 'progress-accepted', orderStatus: 'In Progress', assignmentStatus: 'accepted' },
            { orderId: 'completed-accepted', orderStatus: 'Completed', assignmentStatus: 'accepted' },
            { orderId: 'submitted-pending', orderStatus: 'Submitted', assignmentStatus: 'pending_acceptance' },
            { orderId: 'completed-pending', orderStatus: 'Completed', assignmentStatus: 'pending_acceptance' },
            // getWriterCurrentAssignments normalizes a missing legacy status to accepted.
            { orderId: 'legacy-progress', orderStatus: 'In Progress' },
        ];
        state.completedOrders = [{
            orderId: 'completed-page-two', orderStatus: 'Completed', collegeName: 'Example College',
            yearOfStudying: '3', branch: 'CS', createdDate: '2026-10-01T00:00:00.000Z',
        }];
        state.completedTotalCount = 21;

        const response = await GET(new NextRequest('http://localhost/api/writer/workspace?completedPage=2&completedLimit=1&search=college&sort=oldest'));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.activeOrderCount).toBe(3);
        expect(body.pendingAcceptanceCount).toBe(2);
        expect(body.isAvailable).toBe(true);
        expect(body.pendingAssignments.map((order: { orderId: string }) => order.orderId)).toEqual(['submitted-pending', 'completed-pending']);
        expect(body.activeOrders.map((order: { orderId: string }) => order.orderId)).toEqual([
            'submitted-accepted', 'progress-accepted', 'legacy-progress',
        ]);
        expect(body.activeOrders.every((order: { orderStatus: string }) => order.orderStatus !== 'Completed')).toBe(true);
        expect(body.completedOrders).toHaveLength(1);
        expect(body.completedOrders[0].orderStatus).toBe('Completed');
        expect(body.completedTotalCount).toBe(21);
        expect(body.completedPage).toBe(2);
        expect(body.completedLimit).toBe(1);
        expect(body.completedTotalPages).toBe(21);
        expect(state.expirationCalls).toBe(1);
        expect(state.writerFilter).toMatchObject({
            _id: '507f1f77bcf86cd799439011',
            applicationStatus: 'approved',
        });
        expect(state.completedFilter).toMatchObject({
            assignedWriterId: '507f1f77bcf86cd799439011',
            orderStatus: 'Completed',
        });
        expect(state.completedFilter?.$or).toEqual([
            { orderId: { $regex: 'college', $options: 'i' } },
            { collegeName: { $regex: 'college', $options: 'i' } },
            { yearOfStudying: { $regex: 'college', $options: 'i' } },
            { branch: { $regex: 'college', $options: 'i' } },
        ]);
        expect(state.completedPipeline).toContainEqual({ $skip: 1 });
        expect(state.completedPipeline).toContainEqual({ $limit: 1 });
        expect(getWriterWorkloads).not.toHaveBeenCalled();
    });
});
