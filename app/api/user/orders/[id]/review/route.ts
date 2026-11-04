import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';
import UserModel from '@/lib/models/User';
import { getCustomerOrderOwnerFilter } from '@/lib/customer-order-ownership';

type RouteContext = { params: Promise<{ id: string }> };

function logReviewRejection(reason: string, details: Record<string, boolean | string | null> = {}) {
    console.warn('[customer-review] request rejected', { reason, ...details });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
    const session = getSession(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.role !== 'user' || !mongoose.isValidObjectId(session.sub)) {
        logReviewRejection('customer_session_required', {
            role: session.role,
            subjectIsValidObjectId: mongoose.isValidObjectId(session.sub),
        });
        return NextResponse.json({ error: 'A valid customer account is required. Please sign in again.' }, { status: 403 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return NextResponse.json({ error: 'Invalid review' }, { status: 400 });
    }
    const review = body as { rating?: unknown; displayName?: unknown; text?: unknown };
    if (Object.keys(review).some((key) => !['rating', 'displayName', 'text'].includes(key)) ||
        !Number.isInteger(review.rating) || Number(review.rating) < 1 || Number(review.rating) > 5 ||
        typeof review.displayName !== 'string' || typeof review.text !== 'string') {
        return NextResponse.json({ error: 'Provide a rating, display name, and review text' }, { status: 400 });
    }
    const displayName = review.displayName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    const text = review.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 1000);
    if (displayName.length < 2 || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(displayName) || text.length < 10) {
        return NextResponse.json({ error: 'Display name must be 2–60 characters and review text 10–1000 characters' }, { status: 400 });
    }

    try {
        const { id } = await params;
        if (!/^WX-\d{8}-\d{4,}$/.test(id)) return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });

        await connectDB();
        const email = session.email.toLowerCase().trim();
        const customer = await UserModel.findById(session.sub).select('role email').lean();
        // Legacy customer records may have no stored role. The User schema and
        // customer login both treat a missing role as `user`; lean() does not
        // apply schema defaults, so the value remains undefined here.
        const customerRoleIsCustomer = customer?.role === 'user' || customer?.role === undefined;
        const customerEmailMatches = typeof customer?.email === 'string' && customer.email.toLowerCase().trim() === email;
        if (!customer || !customerRoleIsCustomer || !customerEmailMatches) {
            logReviewRejection('customer_identity_mismatch', {
                customerRecordFound: Boolean(customer),
                customerRoleIsCustomer,
                storedRoleIsWriter: customer?.role === 'writer',
                storedRoleIsMissing: customer?.role === undefined,
                customerEmailMatches,
            });
            return NextResponse.json({ error: 'Your customer session no longer matches an active account. Please sign in again.' }, { status: 403 });
        }

        const ownershipFilter = getCustomerOrderOwnerFilter(email);
        const order = await OrderModel.findOne({ orderId: id, ...ownershipFilter })
            .select('orderId orderStatus deliveryFile completedByWriterId completedAssignmentVersion customerReview')
            .lean();
        if (!order) {
            logReviewRejection('order_not_found_or_not_owned', { orderId: id });
            return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        }
        if (order.customerReview) return NextResponse.json({ error: 'Feedback has already been submitted for this order' }, { status: 409 });
        const statusIsCompleted = order.orderStatus === 'Completed';
        const deliveryFileExists = typeof order.deliveryFile === 'string' && Boolean(order.deliveryFile.trim());
        const writerAttributionExists = typeof order.completedByWriterId === 'string' && Boolean(order.completedByWriterId.trim());
        const assignmentVersionIsValid = Number.isSafeInteger(order.completedAssignmentVersion);
        if (!statusIsCompleted || !deliveryFileExists || !writerAttributionExists || !assignmentVersionIsValid) {
            logReviewRejection('order_not_review_eligible', {
                orderId: id,
                statusIsCompleted,
                deliveryFileExists,
                writerAttributionExists,
                assignmentVersionIsValid,
            });
            const error = !statusIsCompleted
                ? 'Feedback is available after the order is completed.'
                : !deliveryFileExists
                    ? 'Feedback is available after a delivery file is available.'
                    : 'This order is missing its writer completion record. Please contact support.';
            return NextResponse.json({ error }, { status: 409 });
        }

        const submittedAt = new Date().toISOString();
        const updated = await OrderModel.findOneAndUpdate({
            orderId: id,
            ...ownershipFilter,
            orderStatus: 'Completed',
            deliveryFile: { $exists: true, $nin: [null, ''] },
            completedByWriterId: order.completedByWriterId,
            completedAssignmentVersion: order.completedAssignmentVersion,
            customerReview: { $exists: false },
        }, {
            $set: {
                customerReview: {
                    writerId: order.completedByWriterId,
                    reviewerUserId: session.sub,
                    rating: Number(review.rating),
                    displayName,
                    text,
                    submittedAt,
                },
            },
        }, { new: true }).select('customerReview').lean();

        if (!updated) {
            const latest = await OrderModel.findOne({ orderId: id, ...ownershipFilter }).select('customerReview').lean();
            logReviewRejection('review_update_conflict', { orderId: id, reviewNowExists: Boolean(latest?.customerReview) });
            return NextResponse.json({
                error: latest?.customerReview
                    ? 'Feedback has already been submitted for this order'
                    : 'This order is no longer eligible for feedback',
            }, { status: 409 });
        }

        return NextResponse.json({
            feedbackSubmitted: true,
            rating: updated.customerReview?.rating,
            displayName: updated.customerReview?.displayName,
            text: updated.customerReview?.text,
            submittedAt: updated.customerReview?.submittedAt,
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Customer order review error:', error);
        return NextResponse.json({ error: 'Could not submit feedback' }, { status: 500 });
    }
}
