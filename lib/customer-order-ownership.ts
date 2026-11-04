import { normalizeCustomerEmail } from '@/lib/customer-upload';

/** Match new orders by authenticated owner and legacy orders by their historical email field. */
export function getCustomerOrderOwnerFilter(email: string): Record<string, unknown> {
    const normalizedEmail = normalizeCustomerEmail(email);
    return {
        $or: [
            { ownerEmail: normalizedEmail },
            { ownerEmail: { $exists: false }, email: normalizedEmail },
        ],
    };
}

/** Resolve the ownership identity while preserving legacy orders without ownerEmail. */
export function getOrderOwnerEmail(order: { ownerEmail?: unknown; email: string }): string {
    return normalizeCustomerEmail(
        typeof order.ownerEmail === 'string' && order.ownerEmail.trim()
            ? order.ownerEmail
            : order.email
    );
}
