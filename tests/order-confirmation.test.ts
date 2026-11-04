import { describe, expect, it } from 'vitest';
import {
    createOrderConfirmationSnapshot,
    createTrackingConfirmationDetails,
    parseOrderConfirmationSnapshot,
} from '@/lib/order-confirmation';

describe('order confirmation response shapes', () => {
    const createdOrder = {
        orderId: 'WX-20261102-0001',
        userName: 'Test Customer',
        email: 'customer@example.test',
        collegeName: 'Example College',
        branch: 'Computer Science',
        uploadedFiles: ['file-a', 'file-b'],
        priceAmount: 600,
        orderStatus: 'Submitted',
    };

    it('creates a minimal confirmation snapshot from the full order-creation response', () => {
        expect(createOrderConfirmationSnapshot(createdOrder)).toEqual({
            orderId: createdOrder.orderId,
            userName: createdOrder.userName,
            email: createdOrder.email,
            collegeName: createdOrder.collegeName,
            branch: createdOrder.branch,
            uploadedFileCount: 2,
            priceAmount: 600,
            orderStatus: 'Submitted',
        });
    });

    it('does not treat the privacy-limited tracking response as a full confirmation snapshot', () => {
        const trackingResponse = {
            orderId: createdOrder.orderId,
            orderStatus: 'Submitted',
            deliveryAvailable: false,
            physicalDeliveryStatus: 'Pending',
            branch: createdOrder.branch,
            createdDate: '2026-11-02T00:00:00.000Z',
        };

        expect(createOrderConfirmationSnapshot(trackingResponse)).toBeNull();
        expect(createTrackingConfirmationDetails(trackingResponse)).toEqual({
            orderId: createdOrder.orderId,
            orderStatus: 'Submitted',
            branch: createdOrder.branch,
            uploadedFileCount: null,
        });
    });

    it('parses only a valid cached confirmation snapshot', () => {
        const snapshot = createOrderConfirmationSnapshot(createdOrder);
        expect(parseOrderConfirmationSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
        expect(parseOrderConfirmationSnapshot('{invalid json')).toBeNull();
        expect(parseOrderConfirmationSnapshot(JSON.stringify({ ...snapshot, uploadedFileCount: undefined }))).toBeNull();
    });
});
