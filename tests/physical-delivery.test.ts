import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
    order: null as any,
    updates: [] as Array<Record<string, unknown>>,
    updateFails: false,
    session: { sub: '507f1f77bcf86cd799439012', role: 'admin' as string },
}));

vi.mock('@/lib/auth', () => ({
    getSession: () => state.session,
    createDeliveryDownloadToken: () => 'test-token',
}));
vi.mock('@/lib/db', () => ({
    getOrderById: async () => state.order,
    updateOrderWithCompletionSnapshot: async (_id: string, updates: Record<string, unknown>) => {
        if (state.updateFails) return null;
        state.updates.push(updates);
        state.order = { ...state.order, ...updates, completedAt: 'unchanged-completion-time' };
        return state.order;
    },
}));
vi.mock('@/lib/gridfs', () => ({
    deleteFileFromGridFS: vi.fn(),
    getGridFSFileMetadata: async () => ({}),
    uploadFileToGridFS: async () => '507f1f77bcf86cd799439099',
}));
vi.mock('@/lib/file-retention', () => ({ initializeFileRetentionTaskStore: vi.fn() }));
vi.mock('@/lib/file-validation', () => ({
    InvalidDocumentFileError: class InvalidDocumentFileError extends Error {},
    InvalidMultipartBodyError: class InvalidMultipartBodyError extends Error {},
    UploadBodyTooLargeError: class UploadBodyTooLargeError extends Error {},
    parseMultipartFormDataWithinLimit: (request: Request) => request.formData(),
    validateDocumentFile: async ({ filename, bytes }: { filename: string; bytes: Buffer }) => ({
        filename,
        bytes,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        validationVersion: 1,
    }),
}));
vi.mock('@/lib/email', () => ({ sendWorkflowEmail: vi.fn(async () => 'accepted') }));

import { PUT } from '@/app/api/orders/[id]/route';
import { sendWorkflowEmail } from '@/lib/email';

const writerId = '507f1f77bcf86cd799439011';
const submissionId = '507f1f77bcf86cd799439013';
const fileId = '507f1f77bcf86cd799439014';

function baseOrder(overrides: Record<string, unknown> = {}) {
    return {
        orderId: 'WX-20261102-0001', userName: 'Customer', email: 'customer@example.test',
        orderStatus: 'In Progress', physicalDeliveryStatus: 'Pending', createdDate: '2026-11-02',
        uploadedFiles: [], writerSubmissions: [], assignmentHistory: [], ...overrides,
    };
}

function jsonRequest(body: unknown) {
    return new NextRequest('http://localhost/api/orders/WX-20261102-0001', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
}

describe('physical delivery status', () => {
    beforeEach(() => {
        state.updates = [];
        state.updateFails = false;
        state.session = { sub: '507f1f77bcf86cd799439012', role: 'admin' };
        vi.mocked(sendWorkflowEmail).mockClear();
    });

    it('sets Pending while delivering a legacy soft copy and keeps the order Completed', async () => {
        state.order = baseOrder();
        const form = new FormData();
        form.append('orderStatus', 'Completed');
        form.append('deliveryFile', new File(['soft copy'], 'work.docx'));
        const request = new NextRequest('http://localhost/api/orders/WX-20261102-0001', { method: 'PUT', body: form });

        const response = await PUT(request, { params: Promise.resolve({ id: state.order.orderId }) });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(state.updates[0]).toMatchObject({ orderStatus: 'Completed', physicalDeliveryStatus: 'Pending' });
        expect(body.orderStatus).toBe('Completed');
        expect(body.completedAt).toBe('unchanged-completion-time');
        expect(sendWorkflowEmail).toHaveBeenCalledOnce();
        expect(vi.mocked(sendWorkflowEmail).mock.calls[0][0]).toMatchObject({
            event: 'approved_work_delivered',
            to: 'customer@example.test',
            subject: 'Your completed order is ready: WX-20261102-0001',
            text: expect.stringContaining('approved and is ready in your account'),
            action: { label: 'View Completed Work', path: '/track?orderId=WX-20261102-0001' },
            idempotencyKey: 'approved-work-delivered/WX-20261102-0001/legacy-admin',
        });
        expect(sendWorkflowEmail).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'physical_delivery_confirmed' }));
    });

    it('does not notify when the legacy delivery order update fails', async () => {
        state.order = baseOrder();
        state.updateFails = true;
        const form = new FormData();
        form.append('orderStatus', 'Completed');
        form.append('deliveryFile', new File(['soft copy'], 'work.docx'));
        const request = new NextRequest('http://localhost/api/orders/WX-20261102-0001', { method: 'PUT', body: form });

        const response = await PUT(request, { params: Promise.resolve({ id: state.order.orderId }) });

        expect(response.status).toBe(409);
        expect(sendWorkflowEmail).not.toHaveBeenCalled();
    });

    it('does not send another completion notice for a repeated legacy delivery request', async () => {
        state.order = baseOrder();
        const makeRequest = () => {
            const form = new FormData();
            form.append('orderStatus', 'Completed');
            form.append('deliveryFile', new File(['soft copy'], 'work.docx'));
            return new NextRequest('http://localhost/api/orders/WX-20261102-0001', { method: 'PUT', body: form });
        };

        expect((await PUT(makeRequest(), { params: Promise.resolve({ id: state.order.orderId }) })).status).toBe(200);
        expect((await PUT(makeRequest(), { params: Promise.resolve({ id: state.order.orderId }) })).status).toBe(409);

        expect(sendWorkflowEmail).toHaveBeenCalledOnce();
    });

    it('sets Pending when delivering the approved writer submission', async () => {
        state.order = baseOrder({
            assignedWriterId: writerId, assignmentStatus: 'accepted', assignmentVersion: 1,
            writerWorkflowStatus: 'approved', approvedSubmissionId: submissionId,
            currentWriterSubmissionId: submissionId,
            assignmentHistory: [{ writerId, assignmentVersion: 1, status: 'accepted' }],
            writerSubmissions: [{ submissionId, writerId, assignmentVersion: 1, fileId, reviewStatus: 'approved' }],
        });

        const response = await PUT(jsonRequest({ deliverApprovedSubmissionId: submissionId }), { params: Promise.resolve({ id: state.order.orderId }) });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(state.updates[0]).toMatchObject({ orderStatus: 'Completed', physicalDeliveryStatus: 'Pending', deliveryFile: fileId });
        expect(body.orderStatus).toBe('Completed');
    });

    it('sends one physical delivery confirmation on Pending → Delivered without changing completion state', async () => {
        state.order = baseOrder({ orderStatus: 'Completed', deliveryFile: fileId, completedAt: 'unchanged-completion-time' });

        const response = await PUT(jsonRequest({ physicalDeliveryStatus: 'Delivered' }), { params: Promise.resolve({ id: state.order.orderId }) });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(state.updates[0]).toEqual({ physicalDeliveryStatus: 'Delivered' });
        expect(body).toMatchObject({ orderStatus: 'Completed', physicalDeliveryStatus: 'Delivered', completedAt: 'unchanged-completion-time' });
        expect(sendWorkflowEmail).toHaveBeenCalledOnce();
        expect(vi.mocked(sendWorkflowEmail).mock.calls[0][0]).toMatchObject({
            event: 'physical_delivery_confirmed',
            to: 'customer@example.test',
            subject: 'Your WRITING-XPRESS order has been physically delivered',
            text: expect.stringContaining('order WX-20261102-0001'),
            action: { label: 'View My Order', path: '/user/orders/WX-20261102-0001' },
            idempotencyKey: 'physical-delivery-confirmed/WX-20261102-0001',
        });
        expect(vi.mocked(sendWorkflowEmail).mock.calls[0][0]).toMatchObject({
            text: expect.stringContaining('separate from the earlier notification'),
        });
    });

    it('does not send another physical delivery confirmation for an already Delivered order', async () => {
        state.order = baseOrder({ orderStatus: 'Completed', physicalDeliveryStatus: 'Delivered', deliveryFile: fileId });

        const response = await PUT(jsonRequest({ physicalDeliveryStatus: 'Delivered' }), { params: Promise.resolve({ id: state.order.orderId }) });

        expect(response.status).toBe(200);
        expect(sendWorkflowEmail).not.toHaveBeenCalled();
    });

    it('does not send a physical delivery confirmation when the database update fails', async () => {
        state.order = baseOrder({ orderStatus: 'Completed', deliveryFile: fileId });
        state.updateFails = true;

        const response = await PUT(jsonRequest({ physicalDeliveryStatus: 'Delivered' }), { params: Promise.resolve({ id: state.order.orderId }) });

        expect(response.status).toBe(409);
        expect(sendWorkflowEmail).not.toHaveBeenCalled();
    });

    it('does not send a physical delivery confirmation for an unauthorized request', async () => {
        state.session = { sub: '507f1f77bcf86cd799439012', role: 'user' };
        state.order = baseOrder({ orderStatus: 'Completed', deliveryFile: fileId });

        const response = await PUT(jsonRequest({ physicalDeliveryStatus: 'Delivered' }), { params: Promise.resolve({ id: state.order.orderId }) });

        expect(response.status).toBe(403);
        expect(state.updates).toHaveLength(0);
        expect(sendWorkflowEmail).not.toHaveBeenCalled();
    });
});
