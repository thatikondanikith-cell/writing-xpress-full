import { createHash } from 'node:crypto';
import type { Order } from '@/lib/types';

export const CUSTOMER_UPLOAD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const CUSTOMER_UPLOAD_BATCH_PURGE_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeCustomerEmail(value: string): string {
    return value.trim().toLowerCase();
}

export function isValidCustomerEmail(value: string): boolean {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function hashCustomerUploadToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/** Fingerprint only the immutable order fields supplied during checkout. */
export function fingerprintCustomerOrderRequest(
    order: Omit<Order, 'orderId' | 'createdDate' | 'orderStatus'>,
    fileIds: string[],
    ownerEmail = order.email,
): string {
    const canonicalPayload = {
        userName: order.userName,
        primaryPhone: order.primaryPhone,
        alternatePhone: order.alternatePhone ?? null,
        email: normalizeCustomerEmail(order.email),
        ownerEmail: normalizeCustomerEmail(ownerEmail),
        address: order.address ?? null,
        collegeName: order.collegeName,
        yearOfStudying: order.yearOfStudying,
        branch: order.branch,
        uploadedFiles: fileIds,
        instructions: order.instructions,
        priceAmount: order.priceAmount ?? null,
        transactionId: order.transactionId ?? null,
    };
    return createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
}
