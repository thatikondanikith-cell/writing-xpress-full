import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';
import { createDeliveryDownloadToken, getSession } from '@/lib/auth';
import { getCustomerOrderOwnerFilter } from '@/lib/customer-order-ownership';

const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE = 100_000;
const MAX_SEARCH_LENGTH = 100;
const ORDER_STATUSES = ['All', 'Submitted', 'In Progress', 'Completed'] as const;

function parsePositiveInteger(value: string | null, fallback: number, maximum: number): number | null {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
    return Math.min(parsed, maximum);
}

function getCustomerOrderFilter(
    email: string,
    search: string,
    status: typeof ORDER_STATUSES[number],
    month: number | null,
    timeZone: string
): Record<string, unknown> {
    const filter: Record<string, unknown> = getCustomerOrderOwnerFilter(email);
    if (status !== 'All') filter.orderStatus = status;
    if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.orderId = { $regex: escaped, $options: 'i' };
    }
    if (month !== null) {
        filter.$expr = {
            $eq: [
                { $month: { date: { $dateFromString: { dateString: '$createdDate' } }, timezone: timeZone } },
                month + 1,
            ],
        };
    }
    return filter;
}

function makeDeliveryToken(session: Extract<NonNullable<ReturnType<typeof getSession>>, { role: 'user' }>, orderId: string, fileId: string) {
    return createDeliveryDownloadToken(session, orderId, fileId);
}

function serializeLegacyOrders(orders: any[], session: Extract<NonNullable<ReturnType<typeof getSession>>, { role: 'user' }>) {
    return orders.map((doc: any) => {
        const { _id, __v, ...rest } = doc;
        const customerReview = rest.customerReview;
        const completedByWriterId = rest.completedByWriterId;
        const completedAssignmentVersion = rest.completedAssignmentVersion;
        delete rest.customerReview;
        delete rest.completedByWriterId;
        delete rest.completedAssignmentVersion;
        delete rest.writerCompletedAt;
        delete rest.writerWorkflowStatus;
        delete rest.currentWriterSubmissionId;
        delete rest.approvedSubmissionId;
        delete rest.writerSubmissions;
        return {
            ...rest,
            feedbackEligible: rest.orderStatus === 'Completed' && Boolean(
                rest.deliveryFile && completedByWriterId && Number.isSafeInteger(completedAssignmentVersion)
            ),
            // The review endpoint treats any existing customerReview object as final.
            feedbackSubmitted: Boolean(customerReview),
            ...(customerReview?.submittedAt ? { feedbackRating: customerReview.rating } : {}),
            ...(rest.orderStatus === 'Completed' && rest.deliveryFile ? {
                deliveryDownloadToken: makeDeliveryToken(session, rest.orderId, rest.deliveryFile),
            } : {}),
        };
    });
}

export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (session.role !== 'user') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        await connectDB();

        const { searchParams } = new URL(request.url);
        const dashboardKeys = ['page', 'limit', 'search', 'status', 'month'];
        if (dashboardKeys.some((key) => searchParams.has(key))) {
            const isPaginated = searchParams.has('page') || searchParams.has('limit');
            const page = parsePositiveInteger(searchParams.get('page'), 1, MAX_PAGE);
            const limit = parsePositiveInteger(searchParams.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
            const search = searchParams.get('search')?.trim() || '';
            const statusValue = searchParams.get('status') || 'All';
            const monthValue = searchParams.get('month') || 'All';
            const timeZone = searchParams.get('timeZone') || 'UTC';
            let timeZoneIsValid = timeZone.length <= 100;
            try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); } catch { timeZoneIsValid = false; }
            const month = monthValue === 'All' ? null : /^\d{1,2}$/.test(monthValue) ? Number(monthValue) : NaN;
            if (page === null || limit === null || search.length > MAX_SEARCH_LENGTH ||
                !ORDER_STATUSES.includes(statusValue as typeof ORDER_STATUSES[number]) ||
                (month !== null && (!Number.isInteger(month) || month < 0 || month > 11)) || !timeZoneIsValid) {
                return NextResponse.json({ error: 'Invalid customer order query' }, { status: 400 });
            }

            const ownerEmail = session.email.toLowerCase().trim();
            const filter = getCustomerOrderFilter(
                ownerEmail,
                search,
                statusValue as typeof ORDER_STATUSES[number],
                month,
                timeZone
            );
            if (!isPaginated) {
                const filteredOrders = await OrderModel.find(filter)
                    .select('-assignedWriterId -assignedAt -assignedByAdminId -assignmentStatus -assignmentResponseDeadline -assignmentRespondedAt -assignmentOverrideReason -assignmentOverrideAt -assignmentOverrideByAdminId -assignmentVersion -assignmentHistory -writerWorkflowStatus -currentWriterSubmissionId -approvedSubmissionId -writerSubmissions')
                    .sort({ createdDate: -1 })
                    .lean();
                return NextResponse.json(serializeLegacyOrders(filteredOrders, session), {
                    headers: { 'Cache-Control': 'private, no-store' },
                });
            }
            const [orders, totalCount, statusCounts, pendingCandidates] = await Promise.all([
                OrderModel.find(filter)
                    .select('orderId createdDate orderStatus physicalDeliveryStatus collegeName branch yearOfStudying priceAmount instructions deliveryFile completedByWriterId completedAssignmentVersion customerReview')
                    .sort({ createdDate: -1, orderId: -1 })
                    .skip((page - 1) * limit)
                    .limit(limit)
                    .lean(),
                OrderModel.countDocuments(filter),
                OrderModel.aggregate([
                    { $match: getCustomerOrderOwnerFilter(ownerEmail) },
                    { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
                ]),
                OrderModel.find({
                    ...getCustomerOrderOwnerFilter(ownerEmail),
                    orderStatus: 'Completed',
                    deliveryFile: { $exists: true, $nin: [null, ''] },
                    completedByWriterId: { $exists: true, $nin: [null, ''] },
                    customerReview: { $in: [null] },
                })
                    .select('orderId deliveryFile completedAssignmentVersion customerReview')
                    .sort({ createdDate: -1, orderId: -1 })
                    .lean(),
            ]);

            const dashboardOrders = orders.map((order) => {
                const customerReview = order.customerReview;
                const feedbackEligible = order.orderStatus === 'Completed' && Boolean(
                    order.deliveryFile && order.completedByWriterId && Number.isSafeInteger(order.completedAssignmentVersion)
                );
                return {
                    orderId: order.orderId,
                    createdDate: order.createdDate,
                    orderStatus: order.orderStatus,
                    physicalDeliveryStatus: order.physicalDeliveryStatus,
                    collegeName: order.collegeName,
                    branch: order.branch,
                    yearOfStudying: order.yearOfStudying,
                    priceAmount: order.priceAmount,
                    instructions: order.instructions,
                    deliveryFile: order.deliveryFile,
                    feedbackEligible,
                    feedbackSubmitted: Boolean(customerReview),
                    ...(customerReview?.submittedAt ? { feedbackRating: customerReview.rating } : {}),
                    ...(order.orderStatus === 'Completed' && order.deliveryFile ? {
                        deliveryDownloadToken: makeDeliveryToken(session, order.orderId, order.deliveryFile),
                    } : {}),
                };
            });
            const pendingRatings = pendingCandidates
                .flatMap((order) => Number.isSafeInteger(order.completedAssignmentVersion) &&
                    !Boolean(order.customerReview) && typeof order.deliveryFile === 'string' && order.deliveryFile
                    ? [{
                        orderId: order.orderId,
                        deliveryFile: order.deliveryFile,
                        deliveryDownloadToken: makeDeliveryToken(session, order.orderId, order.deliveryFile),
                    }]
                    : []);
            const counts = new Map<string, number>(statusCounts.map((item: { _id: string; count: number }) => [item._id, item.count]));
            const summary = {
                total: [...counts.values()].reduce((sum, count) => sum + count, 0),
                submitted: counts.get('Submitted') || 0,
                inProgress: counts.get('In Progress') || 0,
                completed: counts.get('Completed') || 0,
            };

            return NextResponse.json({
                orders: dashboardOrders,
                page,
                limit,
                totalCount,
                totalPages: Math.max(1, Math.ceil(totalCount / limit)),
                summary,
                pendingRatings,
            }, { headers: { 'Cache-Control': 'private, no-store' } });
        }

        const orders = await OrderModel.find(getCustomerOrderOwnerFilter(session.email))
            .select('-assignedWriterId -assignedAt -assignedByAdminId -assignmentStatus -assignmentResponseDeadline -assignmentRespondedAt -assignmentOverrideReason -assignmentOverrideAt -assignmentOverrideByAdminId -assignmentVersion -assignmentHistory -writerWorkflowStatus -currentWriterSubmissionId -approvedSubmissionId -writerSubmissions')
            .sort({ createdDate: -1 })
            .lean();

        return NextResponse.json(serializeLegacyOrders(orders, session), {
            headers: { 'Cache-Control': 'private, no-store' },
        });

    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Error fetching user orders:', error);
        return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
    }
}
