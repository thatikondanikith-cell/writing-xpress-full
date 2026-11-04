export interface OrderConfirmationDetails {
    orderId: string;
    uploadedFileCount: number | null;
    orderStatus?: string;
    userName?: string;
    email?: string;
    collegeName?: string;
    branch?: string;
    priceAmount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build a minimal browser-only snapshot from the full order-creation response. */
export function createOrderConfirmationSnapshot(value: unknown): OrderConfirmationDetails | null {
    if (
        !isRecord(value) || typeof value.orderId !== 'string' || !value.orderId ||
        typeof value.userName !== 'string' || typeof value.email !== 'string' ||
        typeof value.collegeName !== 'string' || typeof value.branch !== 'string' ||
        typeof value.priceAmount !== 'number' || !Number.isFinite(value.priceAmount) ||
        typeof value.orderStatus !== 'string' || !Array.isArray(value.uploadedFiles)
    ) return null;

    return {
        orderId: value.orderId,
        userName: value.userName,
        email: value.email,
        collegeName: value.collegeName,
        branch: value.branch,
        priceAmount: value.priceAmount,
        orderStatus: value.orderStatus,
        uploadedFileCount: value.uploadedFiles.length,
    };
}

/** Parse only this page's small cached snapshot; do not trust arbitrary storage data. */
export function parseOrderConfirmationSnapshot(value: string | null): OrderConfirmationDetails | null {
    if (!value) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        if (
            !isRecord(parsed) || typeof parsed.orderId !== 'string' || !parsed.orderId ||
            !Number.isSafeInteger(parsed.uploadedFileCount) || (parsed.uploadedFileCount as number) < 0 ||
            typeof parsed.userName !== 'string' || typeof parsed.email !== 'string' ||
            typeof parsed.collegeName !== 'string' || typeof parsed.branch !== 'string' ||
            typeof parsed.priceAmount !== 'number' || !Number.isFinite(parsed.priceAmount) ||
            typeof parsed.orderStatus !== 'string'
        ) return null;

        return parsed as unknown as OrderConfirmationDetails;
    } catch {
        return null;
    }
}

/** Adapt the privacy-limited tracking API response for direct confirmation links. */
export function createTrackingConfirmationDetails(value: unknown): OrderConfirmationDetails | null {
    if (!isRecord(value) || typeof value.orderId !== 'string' || !value.orderId) return null;
    return {
        orderId: value.orderId,
        uploadedFileCount: null,
        ...(typeof value.orderStatus === 'string' ? { orderStatus: value.orderStatus } : {}),
        ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
    };
}
