import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ filter: undefined as unknown, update: undefined as unknown }));

vi.mock('@/lib/auth', () => ({
    getSession: () => ({ sub: '507f1f77bcf86cd799439011', role: 'writer', email: 'writer@example.test' }),
    hasWriterSession: () => true,
}));
vi.mock('@/lib/mongoose', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/assignment-expiration', () => ({ expirePendingWriterAssignments: vi.fn() }));
vi.mock('@/lib/email', () => ({ getAdminNotificationEmail: vi.fn(), sendWorkflowEmail: vi.fn() }));
vi.mock('@/lib/models/User', () => ({ default: { findOne: () => ({ select: () => ({ lean: async () => ({}) }) }) } }));
vi.mock('@/lib/models/Order', () => ({ default: {
    findOne: () => ({ select: () => ({ lean: async () => ({ assignmentResponseDeadline: new Date(Date.now() + 60_000).toISOString() }) }) }),
    findOneAndUpdate: (filter: unknown, update: unknown) => {
        state.filter = filter;
        state.update = update;
        return { select: () => ({ lean: async () => ({ orderId: 'WX-20261102-0001', assignmentStatus: 'accepted', orderStatus: 'In Progress', assignmentVersion: 1 }) }) };
    },
} }));

import { POST } from '@/app/api/writer/orders/[id]/assignment/route';

describe('writer assignment acceptance', () => {
    beforeEach(() => { state.filter = undefined; state.update = undefined; });

    it('atomically changes a Submitted order to In Progress when accepted', async () => {
        const request = new NextRequest('http://localhost/api/writer/orders/WX-20261102-0001/assignment', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'accepted', assignmentVersion: 1 }),
        });

        const response = await POST(request, { params: Promise.resolve({ id: 'WX-20261102-0001' }) });

        expect(response.status).toBe(200);
        expect(state.filter).toMatchObject({ orderStatus: 'Submitted', assignmentStatus: 'pending_acceptance' });
        expect(state.update).toMatchObject({ $set: { orderStatus: 'In Progress', assignmentStatus: 'accepted' } });
    });
});
