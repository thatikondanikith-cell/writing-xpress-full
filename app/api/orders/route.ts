import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import {
    createOrder,
    getAdminOrderDashboardPage,
    getAllOrders,
    InvalidCustomerUploadBatchError,
    CustomerUploadReplayConflictError,
    InvalidOrderFileReferencesError,
} from '@/lib/db';
import { Order } from '@/lib/types';
import { getAdminNotificationEmail, sendWorkflowEmail } from '@/lib/email';
import { emailPaths } from '@/lib/email-template';
import { getSession } from '@/lib/auth';

const MAX_PAGE = 10_000;
const MAX_LIMIT = 50;
const MAX_SEARCH_LENGTH = 200;
const DASHBOARD_STATUSES = ['All', 'Submitted', 'In Progress', 'Completed'] as const;

function parsePositiveInteger(value: string | null, fallback: number, maximum: number): number | null {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
    return Math.min(parsed, maximum);
}

function parseDateBoundary(value: string | null): string | null | undefined {
    if (value === null) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return null;
    return value;
}

// GET all orders (admin only)
export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (session.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const dashboardParams = ['page', 'limit', 'search', 'status', 'dateFrom', 'dateTo'];
        const isDashboardRequest = dashboardParams.some((key) => searchParams.has(key));
        if (!isDashboardRequest) {
            const orders = await getAllOrders();
            return NextResponse.json(orders);
        }

        const page = parsePositiveInteger(searchParams.get('page'), 1, MAX_PAGE);
        const limit = parsePositiveInteger(searchParams.get('limit'), 10, MAX_LIMIT);
        const search = searchParams.get('search')?.trim() || '';
        const statusValue = searchParams.get('status') || 'All';
        const dateFrom = parseDateBoundary(searchParams.get('dateFrom'));
        const dateTo = parseDateBoundary(searchParams.get('dateTo'));
        if (page === null || limit === null || search.length > MAX_SEARCH_LENGTH ||
            !DASHBOARD_STATUSES.includes(statusValue as typeof DASHBOARD_STATUSES[number]) ||
            dateFrom === null || dateTo === null ||
            (dateFrom === undefined) !== (dateTo === undefined) ||
            (dateFrom !== undefined && dateTo !== undefined && dateFrom >= dateTo)) {
            return NextResponse.json({ error: 'Invalid dashboard order query' }, { status: 400 });
        }

        const result = await getAdminOrderDashboardPage({
            page,
            limit,
            search,
            status: statusValue as 'All' | 'Submitted' | 'In Progress' | 'Completed',
            ...(dateFrom !== undefined && dateTo !== undefined ? { dateFrom, dateTo } : {}),
        });
        return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Error fetching orders:', error);
        return NextResponse.json(
            { error: 'Failed to fetch orders' },
            { status: 500 }
        );
    }
}

// POST create new order
export async function POST(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'user' || !mongoose.isValidObjectId(session.sub)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();

        if (typeof body.uploadToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.uploadToken)) {
            return NextResponse.json({ error: 'Your uploaded files have expired or are invalid. Please upload them again.' }, { status: 400 });
        }

        // Validate required fields
        const requiredFields = [
            'userName',
            'primaryPhone',
            'email',
            'collegeName',
            'yearOfStudying',
            'branch',
            'uploadedFiles',
            'instructions',
            'priceAmount',
            'transactionId'
        ];

        for (const field of requiredFields) {
            if (!body[field]) {
                return NextResponse.json(
                    { error: `Missing required field: ${field}` },
                    { status: 400 }
                );
            }
        }

        // Validate files array
        if (!Array.isArray(body.uploadedFiles) || body.uploadedFiles.length === 0) {
            return NextResponse.json(
                { error: 'At least one file must be uploaded' },
                { status: 400 }
            );
        }

        const orderData: Omit<Order, 'orderId' | 'createdDate' | 'orderStatus'> = {
            userName: body.userName,
            primaryPhone: body.primaryPhone,
            alternatePhone: body.alternatePhone,
            email: body.email,
            address: body.address,
            collegeName: body.collegeName,
            yearOfStudying: body.yearOfStudying,
            branch: body.branch,
            uploadedFiles: body.uploadedFiles,
            instructions: body.instructions,
            priceAmount: body.priceAmount,
            transactionId: body.transactionId,
        };

        const result = await createOrder(orderData, body.uploadToken, session.email);
        if (result.created) {
            await sendWorkflowEmail({
                event: 'order_submitted',
                to: result.order.email,
                subject: `Order received: ${result.order.orderId}`,
                text: `We received your WRITING-XPRESS order and will review the details before assigning it to a writer.\n\nOrder ID: ${result.order.orderId}\n\nUse the order tracker to follow its status. You can also sign in to view your order details.`,
                action: { label: 'Track Your Order', path: emailPaths(result.order.orderId).trackOrder },
                idempotencyKey: `order-submitted/${result.order.orderId}`,
            });

            const adminEmail = getAdminNotificationEmail();
            if (adminEmail) {
                const submittedAt = new Date(result.order.createdDate);
                const formattedDate = Number.isNaN(submittedAt.getTime())
                    ? result.order.createdDate
                    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(submittedAt);
                const amount = typeof result.order.priceAmount === 'number' && Number.isFinite(result.order.priceAmount)
                    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(result.order.priceAmount)
                    : 'Not provided';
                const subject = 'New Order Received – WRITING-XPRESS';
                const details = [
                    `Order ID: ${result.order.orderId}`,
                    `Customer name: ${result.order.userName}`,
                    `Customer contact email: ${result.order.email}`,
                    `Assignment type: ${result.order.branch}`,
                    `Order submission date: ${formattedDate}`,
                    `Order amount: ${amount}`,
                    `Current order status: ${result.order.orderStatus}`,
                ].join('\n');
                const text = `A customer has successfully submitted a new order. Please review the order details and proceed with the assignment process.\n\n${details}`;
                await sendWorkflowEmail({
                    event: 'admin_new_order',
                    to: adminEmail,
                    subject,
                    heading: 'A New Order Has Been Placed!',
                    text,
                    action: { label: 'View Order', path: emailPaths(result.order.orderId).adminOrder },
                    idempotencyKey: `admin-new-order/${result.order.orderId}`,
                });
            }
        }
        return NextResponse.json(result.order, { status: result.created ? 201 : 200 });

    } catch (error) {
        if (error instanceof InvalidOrderFileReferencesError) {
            return NextResponse.json({ error: 'One or more uploaded files are invalid or no longer available' }, { status: 400 });
        }
        if (error instanceof InvalidCustomerUploadBatchError) {
            return NextResponse.json({ error: 'Your uploaded files have expired or are invalid. Please upload them again.' }, { status: 400 });
        }
        if (error instanceof CustomerUploadReplayConflictError) {
            return NextResponse.json({ error: 'This upload was already used for a different order request.' }, { status: 409 });
        }
        if (error instanceof Error && /transaction|replica set|mongos/i.test(error.message)) {
            return NextResponse.json({ error: 'Order creation requires a transaction-capable MongoDB deployment' }, { status: 503 });
        }
        console.error('Error creating order:', error);
        return NextResponse.json(
            { error: 'Failed to create order' },
            { status: 500 }
        );
    }
}
