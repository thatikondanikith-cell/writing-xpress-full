import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getOrderById, updateOrderWithCompletionSnapshot } from '@/lib/db';
import { deleteFileFromGridFS, getGridFSFileMetadata, uploadFileToGridFS } from '@/lib/gridfs';
import { createDeliveryDownloadToken, getSession } from '@/lib/auth';
import { getOrderOwnerEmail } from '@/lib/customer-order-ownership';
import { Order, WriterSubmission } from '@/lib/types';
import { sendWorkflowEmail } from '@/lib/email';
import { emailPaths } from '@/lib/email-template';
import { canTransitionOrderStatus } from '@/lib/order-lifecycle';
import { initializeFileRetentionTaskStore } from '@/lib/file-retention';
import {
    InvalidDocumentFileError,
    InvalidMultipartBodyError,
    parseMultipartFormDataWithinLimit,
    UploadBodyTooLargeError,
    validateDocumentFile,
} from '@/lib/file-validation';

const MIB = 1024 * 1024;
const MAX_ADMIN_DELIVERY_FILE_BYTES = 3.5 * MIB;
const MAX_ADMIN_DELIVERY_REQUEST_BYTES = 4 * MIB;

function isWriterManagedOrder(order: Order): boolean {
    return Boolean(
        order.assignedWriterId || order.assignedAt || order.assignmentHistory?.length ||
        order.writerSubmissions?.length || order.currentWriterSubmissionId || order.approvedSubmissionId ||
        (order.writerWorkflowStatus && order.writerWorkflowStatus !== 'not_started')
    );
}

const LEGACY_ORDER_FILTER = {
    $and: [
        { assignedWriterId: { $in: [null, ''] } },
        { currentWriterSubmissionId: { $in: [null, ''] } },
        { approvedSubmissionId: { $in: [null, ''] } },
        { assignmentVersion: { $in: [null, 0] } },
        { assignmentStatus: { $in: [null, ''] } },
        { $or: [{ assignmentHistory: { $exists: false } }, { assignmentHistory: { $size: 0 } }] },
        { $or: [{ writerSubmissions: { $exists: false } }, { writerSubmissions: { $size: 0 } }] },
        { $or: [{ writerWorkflowStatus: { $exists: false } }, { writerWorkflowStatus: 'not_started' }] },
    ],
};

function isSubmissionAssignmentConsistent(order: Order, submission: WriterSubmission): boolean {
    const version = order.assignmentVersion || 0;
    if (
        submission.writerId !== order.assignedWriterId || submission.assignmentVersion !== version ||
        (order.assignmentStatus !== 'accepted' && !(version === 0 && !order.assignmentStatus))
    ) return false;

    return Boolean(order.assignmentHistory?.some((attempt) =>
        attempt.writerId === submission.writerId && attempt.assignmentVersion === version &&
        (attempt.status === 'accepted' || (attempt.status === 'reassigned' && Boolean(attempt.respondedAt)))
    ) || (version === 0 && !order.assignmentHistory?.length));
}

function parseCompletionCandidate(writerId: unknown, assignmentVersion: unknown) {
    if (writerId === undefined && assignmentVersion === undefined) return { candidate: undefined };
    if (
        typeof writerId !== 'string' || !mongoose.isValidObjectId(writerId) ||
        typeof assignmentVersion !== 'number' || !Number.isSafeInteger(assignmentVersion) || assignmentVersion < 0
    ) return { error: 'Invalid completion attribution' };
    return { candidate: { writerId, assignmentVersion } };
}

// GET order by ID
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = getSession(request);
        const { id } = await params;
        const order = await getOrderById(id);

        if (!order) {
            return NextResponse.json(
                { error: 'Order not found' },
                { status: 404 }
            );
        }

        if (session?.role === 'admin') {
            return NextResponse.json(order, {
                headers: { 'Cache-Control': 'private, no-store' },
            });
        }

        if (session?.role === 'user' && getOrderOwnerEmail(order) !== session.email.toLowerCase().trim()) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        }

        const trackingResponse: Record<string, unknown> = {
            orderStatus: order.orderStatus,
            deliveryAvailable: Boolean(order.deliveryFile),
            physicalDeliveryStatus: order.physicalDeliveryStatus,
            orderId: order.orderId,
            branch: order.branch,
            createdDate: order.createdDate,
        };

        if (
            session?.role === 'user' && order.orderStatus === 'Completed' && order.deliveryFile &&
            session.email.toLowerCase().trim() === getOrderOwnerEmail(order)
        ) {
            trackingResponse.deliveryFile = order.deliveryFile;
            trackingResponse.deliveryDownloadToken = createDeliveryDownloadToken(
                session,
                order.orderId,
                order.deliveryFile
            );
        }

        return NextResponse.json(trackingResponse, {
            headers: { 'Cache-Control': 'private, no-store' },
        });
    } catch (error) {
        console.error('Error fetching order:', error);
        return NextResponse.json(
            { error: 'Failed to fetch order' },
            { status: 500 }
        );
    }
}

// PUT update order (admin only)
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = getSession(request);
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (session.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { id } = await params;
        const order = await getOrderById(id);
        if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        const previousDeliveryFileId = typeof order.deliveryFile === 'string' && mongoose.isValidObjectId(order.deliveryFile)
            ? order.deliveryFile
            : undefined;
        const contentType = request.headers.get('content-type');

        // Handle file upload for delivery file
        if (contentType?.includes('multipart/form-data')) {
            if (isWriterManagedOrder(order)) {
                return NextResponse.json({ error: 'Writer-managed orders must be delivered from their currently approved submission.' }, { status: 409 });
            }
            let formData: FormData;
            try {
                formData = await parseMultipartFormDataWithinLimit(request, MAX_ADMIN_DELIVERY_REQUEST_BYTES);
            } catch (error) {
                if (error instanceof UploadBodyTooLargeError) {
                    return NextResponse.json({ error: 'The delivery request must be 4 MiB or smaller.' }, { status: 413 });
                }
                if (error instanceof InvalidMultipartBodyError) {
                    return NextResponse.json({ error: 'Invalid multipart delivery request.' }, { status: 400 });
                }
                throw error;
            }
            const deliveryFiles = formData.getAll('deliveryFile');
            if (deliveryFiles.length > 1 || (deliveryFiles.length === 1 && !(deliveryFiles[0] instanceof File))) {
                return NextResponse.json({ error: 'Choose one valid delivery file.' }, { status: 400 });
            }
            const file = deliveryFiles.length ? deliveryFiles[0] as File : null;
            const orderStatus = formData.get('orderStatus') as string | null;
            const physicalDeliveryStatus = formData.get('physicalDeliveryStatus') as 'Pending' | 'Delivered' | null;
            const versionValue = formData.get('completedAssignmentVersion');
            const attribution = parseCompletionCandidate(
                formData.get('completedByWriterId') || undefined,
                versionValue === null ? undefined : Number(versionValue)
            );
            if ('error' in attribution) return NextResponse.json({ error: attribution.error }, { status: 400 });

            if (orderStatus && !['Submitted', 'In Progress', 'Completed'].includes(orderStatus)) {
                return NextResponse.json({ error: 'Invalid order status' }, { status: 400 });
            }
            if (physicalDeliveryStatus && !['Pending', 'Delivered'].includes(physicalDeliveryStatus)) {
                return NextResponse.json({ error: 'Invalid physical delivery status' }, { status: 400 });
            }

            if (orderStatus && !canTransitionOrderStatus(order.orderStatus, orderStatus as Order['orderStatus'])) {
                return NextResponse.json({ error: 'Invalid order status transition' }, { status: 409 });
            }
            if (orderStatus === 'Completed' && (!file || order.orderStatus !== 'In Progress')) {
                return NextResponse.json({ error: 'An in-progress legacy order requires a delivery file to be completed.' }, { status: 409 });
            }
            if (file && orderStatus !== 'Completed') {
                return NextResponse.json({ error: 'A delivery file can only be uploaded when completing an order.' }, { status: 400 });
            }

            if (file) {
                if (file.size > MAX_ADMIN_DELIVERY_FILE_BYTES) {
                    return NextResponse.json({ error: 'The delivery file must be 3.5 MiB or smaller.' }, { status: 413 });
                }
                let validatedFile;
                try {
                    validatedFile = await validateDocumentFile({
                        filename: file.name,
                        declaredMimeType: file.type,
                        bytes: Buffer.from(await file.arrayBuffer()),
                    });
                } catch (error) {
                    if (error instanceof InvalidDocumentFileError) {
                        return NextResponse.json({ error: 'Only valid PDF, Word, and PowerPoint delivery files are allowed.' }, { status: 400 });
                    }
                    throw error;
                }

                if (previousDeliveryFileId) await initializeFileRetentionTaskStore();

                const timestamp = Date.now();
                const storedFilename = `delivery-${timestamp}-${validatedFile.filename}`;

                // Upload delivery file to GridFS
                const fileId = await uploadFileToGridFS(
                    validatedFile.bytes,
                    storedFilename,
                    validatedFile.mimeType,
                    'delivery',
                    {
                        fileValidationVersion: validatedFile.validationVersion,
                        validatedContentType: validatedFile.mimeType,
                    }
                );

                const updates: any = { deliveryFile: fileId, physicalDeliveryStatus: 'Pending' };
                if (orderStatus) updates.orderStatus = orderStatus;
                if (physicalDeliveryStatus) updates.physicalDeliveryStatus = physicalDeliveryStatus;

                const updatedOrder = await updateOrderWithCompletionSnapshot(
                    id,
                    updates,
                    attribution.candidate,
                    LEGACY_ORDER_FILTER,
                    previousDeliveryFileId
                );

                if (!updatedOrder) {
                    try { await deleteFileFromGridFS(fileId); } catch (cleanupError) {
                        console.error('Could not clean up a rejected delivery file:', cleanupError);
                    }
                    if (await getOrderById(id)) {
                        return NextResponse.json({ error: 'The order changed during delivery. Refresh and try again.' }, { status: 409 });
                    }
                    return NextResponse.json(
                        { error: 'Order not found' },
                        { status: 404 }
                    );
                }

                if (order.orderStatus !== 'Completed' && updatedOrder.orderStatus === 'Completed') {
                    await sendWorkflowEmail({
                        event: 'approved_work_delivered',
                        to: updatedOrder.email,
                        subject: `Your completed order is ready: ${updatedOrder.orderId}`,
                        text: `Hello ${updatedOrder.userName},\n\nThe work for order ${updatedOrder.orderId} has been approved and is ready in your account. Sign in with the account used to place the order to view the order details and access the completed work.`,
                        action: { label: 'View Completed Work', path: emailPaths(updatedOrder.orderId).trackOrder },
                        idempotencyKey: `approved-work-delivered/${updatedOrder.orderId}/legacy-admin`,
                    });
                }

                return NextResponse.json(updatedOrder);
            }

            if (orderStatus || physicalDeliveryStatus) {
                const updates: Partial<Order> = {};
                if (orderStatus) updates.orderStatus = orderStatus as Order['orderStatus'];
                if (physicalDeliveryStatus) updates.physicalDeliveryStatus = physicalDeliveryStatus;
                const updatedOrder = await updateOrderWithCompletionSnapshot(
                    id,
                    updates,
                    undefined,
                    LEGACY_ORDER_FILTER
                );
                if (!updatedOrder) return NextResponse.json({ error: 'The order changed during this update. Refresh and try again.' }, { status: 409 });
                return NextResponse.json(updatedOrder);
            }
            return NextResponse.json({ error: 'No supported order updates were provided' }, { status: 400 });
        }

        // Handle JSON update (status, physicalDeliveryStatus, etc.)
        const body = await request.json();
        if (body && typeof body === 'object' && !Array.isArray(body) && 'deliverApprovedSubmissionId' in body) {
            if (Object.keys(body).length !== 1 || typeof body.deliverApprovedSubmissionId !== 'string' || !mongoose.isValidObjectId(body.deliverApprovedSubmissionId)) {
                return NextResponse.json({ error: 'Invalid approved submission' }, { status: 400 });
            }
            const submissionId = body.deliverApprovedSubmissionId as string;
            const approvedSubmission = order.writerSubmissions?.find((submission) => submission.submissionId === submissionId);
            if (
                !isWriterManagedOrder(order) || order.writerWorkflowStatus !== 'approved' ||
                order.approvedSubmissionId !== submissionId || order.currentWriterSubmissionId !== submissionId ||
                !approvedSubmission || approvedSubmission.reviewStatus !== 'approved' ||
                !mongoose.isValidObjectId(approvedSubmission.fileId) ||
                !isSubmissionAssignmentConsistent(order, approvedSubmission) ||
                (order.completedByWriterId !== undefined && (
                    order.completedByWriterId !== approvedSubmission.writerId ||
                    order.completedAssignmentVersion !== approvedSubmission.assignmentVersion
                ))
            ) {
                return NextResponse.json({ error: 'No current, valid approved submission is ready for delivery.' }, { status: 409 });
            }
            if (order.deliveryFile && order.deliveryFile !== approvedSubmission.fileId) {
                return NextResponse.json({ error: 'A different delivery file is already associated with this order.' }, { status: 409 });
            }
            if (order.deliveryFile === approvedSubmission.fileId && order.orderStatus === 'Completed') {
                return NextResponse.json(order, { headers: { 'Cache-Control': 'private, no-store' } });
            }
            if (order.orderStatus !== 'In Progress') {
                return NextResponse.json({ error: 'Only an in-progress order can be completed.' }, { status: 409 });
            }
            try {
                await getGridFSFileMetadata(approvedSubmission.fileId);
            } catch {
                return NextResponse.json({ error: 'The approved delivery file is unavailable.' }, { status: 409 });
            }

            const version = approvedSubmission.assignmentVersion;
            const historyMatch = {
                $or: [
                    { assignmentHistory: { $elemMatch: { writerId: approvedSubmission.writerId, assignmentVersion: version, status: 'accepted' } } },
                    { assignmentHistory: { $elemMatch: { writerId: approvedSubmission.writerId, assignmentVersion: version, status: 'reassigned', respondedAt: { $exists: true, $ne: '' } } } },
                    ...(version === 0 ? [{
                        assignedWriterId: approvedSubmission.writerId,
                        assignmentStatus: { $in: ['accepted', null] },
                        assignmentVersion: { $in: [0, null] },
                        $expr: { $eq: [{ $size: { $ifNull: ['$assignmentHistory', []] } }, 0] },
                    }] : []),
                ],
            };
            const approvedFilter = {
                writerWorkflowStatus: 'approved',
                approvedSubmissionId: submissionId,
                currentWriterSubmissionId: submissionId,
                assignedWriterId: approvedSubmission.writerId,
                assignmentStatus: 'accepted',
                assignmentVersion: version,
                deliveryFile: { $in: [null, '', approvedSubmission.fileId] },
                writerSubmissions: { $elemMatch: {
                    submissionId,
                    writerId: approvedSubmission.writerId,
                    assignmentVersion: version,
                    fileId: approvedSubmission.fileId,
                    reviewStatus: 'approved',
                } },
                ...historyMatch,
            };
            const updatedOrder = await updateOrderWithCompletionSnapshot(
                id,
                { deliveryFile: approvedSubmission.fileId, orderStatus: 'Completed', physicalDeliveryStatus: 'Pending' },
                { writerId: approvedSubmission.writerId, assignmentVersion: version },
                approvedFilter
            );
            if (!updatedOrder) {
                return NextResponse.json({ error: 'The approved submission changed before delivery. Refresh and try again.' }, { status: 409 });
            }
            await sendWorkflowEmail({
                event: 'approved_work_delivered',
                to: updatedOrder.email,
                subject: `Your completed order is ready: ${updatedOrder.orderId}`,
                text: `Hello ${updatedOrder.userName},\n\nThe work for order ${updatedOrder.orderId} has been approved and is ready in your account. Sign in with the account used to place the order to view the order details and access the completed work.`,
                action: { label: 'View Completed Work', path: emailPaths(updatedOrder.orderId).trackOrder },
                idempotencyKey: `approved-work-delivered/${updatedOrder.orderId}/${submissionId}`,
            });
            return NextResponse.json(updatedOrder, { headers: { 'Cache-Control': 'private, no-store' } });
        }

        const allowedFields = ['orderStatus', 'physicalDeliveryStatus', 'completedByWriterId', 'completedAssignmentVersion'];
        if (
            !body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowedFields.includes(key))
        ) {
            return NextResponse.json({ error: 'Only order status fields may be updated here' }, { status: 400 });
        }
        if (body.orderStatus !== undefined && !['Submitted', 'In Progress', 'Completed'].includes(body.orderStatus)) {
            return NextResponse.json({ error: 'Invalid order status' }, { status: 400 });
        }
        if (body.physicalDeliveryStatus !== undefined && !['Pending', 'Delivered'].includes(body.physicalDeliveryStatus)) {
            return NextResponse.json({ error: 'Invalid physical delivery status' }, { status: 400 });
        }
        if (
            body.orderStatus !== undefined &&
            !canTransitionOrderStatus(order.orderStatus, body.orderStatus as Order['orderStatus'])
        ) {
            return NextResponse.json({ error: 'Invalid order status transition' }, { status: 409 });
        }

        const attribution = parseCompletionCandidate(body.completedByWriterId, body.completedAssignmentVersion);
        if ('error' in attribution) return NextResponse.json({ error: attribution.error }, { status: 400 });

        if (isWriterManagedOrder(order)) {
            if (body.completedByWriterId !== undefined || body.completedAssignmentVersion !== undefined) {
                return NextResponse.json({ error: 'Writer completion attribution is derived from the approved submission.' }, { status: 400 });
            }
            if (body.orderStatus === 'Completed') {
                return NextResponse.json({ error: 'Complete writer-managed orders by delivering the current approved submission.' }, { status: 409 });
            }
        }

        if (body.orderStatus === 'Completed' && order.orderStatus === 'In Progress' && !isWriterManagedOrder(order)) {
            if (!order.deliveryFile) {
                return NextResponse.json({ error: 'A delivery file is required to complete this order.' }, { status: 409 });
            }
            try {
                await getGridFSFileMetadata(order.deliveryFile);
            } catch {
                return NextResponse.json({ error: 'The delivery file is unavailable.' }, { status: 409 });
            }
        }

        const updates = { ...body };
        delete updates.completedByWriterId;
        delete updates.completedAssignmentVersion;
        const updatedOrder = await updateOrderWithCompletionSnapshot(
            id,
            updates,
            attribution.candidate,
            !isWriterManagedOrder(order) && body.orderStatus === 'Completed' ? LEGACY_ORDER_FILTER : undefined
        );

        if (!updatedOrder) {
            if (await getOrderById(id)) {
                return NextResponse.json({ error: 'The order changed during this update. Refresh and try again.' }, { status: 409 });
            }
            return NextResponse.json(
                { error: 'Order not found' },
                { status: 404 }
            );
        }

        if (body.physicalDeliveryStatus === 'Delivered' && order.physicalDeliveryStatus !== 'Delivered' && updatedOrder.physicalDeliveryStatus === 'Delivered') {
            await sendWorkflowEmail({
                event: 'physical_delivery_confirmed',
                to: updatedOrder.email,
                subject: 'Your WRITING-XPRESS order has been physically delivered',
                text: `Hello ${updatedOrder.userName},\n\nThis email confirms that order ${updatedOrder.orderId} has been physically delivered. This is separate from the earlier notification that your completed work was available online.\n\nSign in with the account used to place the order if you would like to review its details.`,
                action: { label: 'View My Order', path: emailPaths(updatedOrder.orderId).customerOrder },
                idempotencyKey: `physical-delivery-confirmed/${updatedOrder.orderId}`,
            });
        }

        return NextResponse.json(updatedOrder);

    } catch (error) {
        if (error instanceof Error && /transaction|replica set|mongos/i.test(error.message)) {
            return NextResponse.json({ error: 'Order updates require a transaction-capable MongoDB deployment' }, { status: 503 });
        }
        console.error('Error updating order:', error);
        return NextResponse.json(
            { error: 'Failed to update order' },
            { status: 500 }
        );
    }
}
