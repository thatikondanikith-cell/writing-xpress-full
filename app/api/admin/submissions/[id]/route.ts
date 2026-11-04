import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';
import UserModel from '@/lib/models/User';
import { getGridFSFileMetadata } from '@/lib/gridfs';
import { updateOrderWithCompletionSnapshot } from '@/lib/db';
import { sendWorkflowEmail } from '@/lib/email';
import { emailPaths } from '@/lib/email-template';

type RouteContext = { params: Promise<{ id: string }> };
const ORDER_ID_PATTERN = /^WX-\d{8}-\d{4,}$/;

export async function GET(request: NextRequest, { params }: RouteContext) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        const { id } = await params;
        if (!ORDER_ID_PATTERN.test(id)) return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });

        await connectDB();
        const order = await OrderModel.findOne({ orderId: id })
            .select('orderId orderStatus deliveryFile userName collegeName yearOfStudying branch instructions createdDate assignedWriterId assignmentStatus assignmentVersion writerWorkflowStatus currentWriterSubmissionId approvedSubmissionId writerSubmissions')
            .lean();
        if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        const writers = await UserModel.find({ _id: { $in: [...new Set((order.writerSubmissions || []).map((item) => item.writerId).filter(mongoose.isValidObjectId))] } })
            .select('_id name email').lean();
        const writerById = new Map(writers.map((writer) => [writer._id.toString(), writer]));
        const submissions = (order.writerSubmissions || []).map((submission) => ({
            submissionId: submission.submissionId,
            writerId: submission.writerId,
            writer: writerById.get(submission.writerId)
                ? { name: writerById.get(submission.writerId)!.name, email: writerById.get(submission.writerId)!.email }
                : { name: 'Writer account unavailable', email: '' },
            assignmentVersion: submission.assignmentVersion,
            submittedAt: submission.submittedAt,
            reviewStatus: submission.reviewStatus,
            reviewedAt: submission.reviewedAt,
            reviewedByAdminId: submission.reviewedByAdminId,
            reviewFeedback: submission.reviewFeedback,
            supersededAt: submission.supersededAt,
            fileUrl: `/api/files/${encodeURIComponent(submission.fileId)}`,
            isCurrent: submission.submissionId === order.currentWriterSubmissionId,
            isApproved: submission.submissionId === order.approvedSubmissionId,
            isDelivered: submission.submissionId === order.approvedSubmissionId && submission.fileId === order.deliveryFile && order.orderStatus === 'Completed',
        }));
        return NextResponse.json({
            order: {
                orderId: order.orderId,
                orderStatus: order.orderStatus,
                deliveryFile: order.deliveryFile || null,
                userName: order.userName,
                collegeName: order.collegeName,
                yearOfStudying: order.yearOfStudying,
                branch: order.branch,
                instructions: order.instructions,
                createdDate: order.createdDate,
            },
            assignment: {
                writerId: order.assignedWriterId?.toString() || null,
                status: order.assignmentStatus || (order.assignedWriterId ? 'accepted' : null),
                version: order.assignmentVersion || 0,
            },
            workflowStatus: order.writerWorkflowStatus || 'not_started',
            currentSubmissionId: order.currentWriterSubmissionId || null,
            approvedSubmissionId: order.approvedSubmissionId || null,
            submissions,
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Admin submission detail error:', error);
        return NextResponse.json({ error: 'Could not load submission details' }, { status: 500 });
    }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        const { id } = await params;
        if (!ORDER_ID_PATTERN.test(id)) return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });

        let body: unknown;
        try { body = await request.json(); } catch {
            return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: 'Invalid review decision' }, { status: 400 });
        }
        const data = body as Record<string, unknown>;
        if (Object.keys(data).some((key) => !['submissionId', 'assignmentVersion', 'decision', 'feedback'].includes(key)) ||
            typeof data.submissionId !== 'string' || !mongoose.isValidObjectId(data.submissionId) ||
            typeof data.assignmentVersion !== 'number' || !Number.isSafeInteger(data.assignmentVersion) || data.assignmentVersion < 0 ||
            !['approved', 'revision_required'].includes(String(data.decision))) {
            return NextResponse.json({ error: 'Invalid review decision' }, { status: 400 });
        }
        const feedback = typeof data.feedback === 'string' ? data.feedback.trim() : '';
        if (data.decision === 'revision_required' && (feedback.length < 10 || feedback.length > 2000)) {
            return NextResponse.json({ error: 'Revision feedback must be 10 to 2000 characters' }, { status: 400 });
        }
        if (data.decision === 'approved' && data.feedback !== undefined) {
            return NextResponse.json({ error: 'Feedback is only accepted when requesting revisions' }, { status: 400 });
        }

        await connectDB();
        const decision = data.decision as 'approved' | 'revision_required';
        const now = new Date().toISOString();
        const currentOrder = await OrderModel.findOne({
            orderId: id,
            orderStatus: 'In Progress',
            assignmentStatus: 'accepted',
            assignmentVersion: data.assignmentVersion,
            writerWorkflowStatus: 'submitted_for_review',
            currentWriterSubmissionId: data.submissionId,
        }).select('orderStatus assignedWriterId assignmentVersion deliveryFile writerSubmissions').lean();
        const targetSubmission = currentOrder?.writerSubmissions?.find((item) =>
            item.submissionId === data.submissionId &&
            item.assignmentVersion === data.assignmentVersion &&
            item.reviewStatus === 'pending_review'
        );
        if (!currentOrder || !targetSubmission || targetSubmission.writerId !== currentOrder.assignedWriterId?.toString()) {
            return NextResponse.json({ error: 'This submission is stale, already decided, or no longer assigned to its writer. Refresh the review data.' }, { status: 409 });
        }
        const writer = await UserModel.findOne({ _id: targetSubmission.writerId, role: { $in: ['writer', 'user'] }, applicationStatus: 'approved' })
            .select('name email').lean();
        const filter = {
            orderId: id,
            orderStatus: 'In Progress',
            assignedWriterId: targetSubmission.writerId,
            assignmentStatus: 'accepted',
            assignmentVersion: data.assignmentVersion,
            writerWorkflowStatus: 'submitted_for_review',
            currentWriterSubmissionId: data.submissionId,
            writerSubmissions: { $elemMatch: {
                submissionId: data.submissionId,
                assignmentVersion: data.assignmentVersion,
                reviewStatus: 'pending_review',
                writerId: targetSubmission.writerId,
            } },
        };
        if (decision === 'approved') {
            if (!mongoose.isValidObjectId(targetSubmission.fileId) ||
                (currentOrder.deliveryFile && currentOrder.deliveryFile !== targetSubmission.fileId)) {
                return NextResponse.json({ error: 'The approved submission file is invalid or conflicts with an existing delivery.' }, { status: 409 });
            }
            try {
                await getGridFSFileMetadata(targetSubmission.fileId);
            } catch {
                return NextResponse.json({ error: 'The approved submission file is unavailable.' }, { status: 409 });
            }

            const approvedFilter = {
                ...filter,
                deliveryFile: { $in: [null, '', targetSubmission.fileId] },
                writerSubmissions: { $elemMatch: {
                    submissionId: data.submissionId,
                    assignmentVersion: data.assignmentVersion,
                    writerId: targetSubmission.writerId,
                    fileId: targetSubmission.fileId,
                    reviewStatus: 'pending_review',
                } },
            };
            const completedOrder = await updateOrderWithCompletionSnapshot(
                id,
                {
                    orderStatus: 'Completed',
                    physicalDeliveryStatus: 'Pending',
                    deliveryFile: targetSubmission.fileId,
                    writerWorkflowStatus: 'approved',
                    approvedSubmissionId: data.submissionId,
                },
                { writerId: targetSubmission.writerId, assignmentVersion: data.assignmentVersion },
                approvedFilter,
                undefined,
                {
                    submissionId: data.submissionId,
                    writerId: targetSubmission.writerId,
                    assignmentVersion: data.assignmentVersion,
                    reviewedByAdminId: session.sub,
                }
            );
            if (!completedOrder) {
                return NextResponse.json({ error: 'This submission is stale, already decided, or the order changed. Refresh the review data.' }, { status: 409 });
            }

            await sendWorkflowEmail({
                event: 'writer_submission_approved',
                to: writer?.email,
                subject: `Your submission was approved: ${id}`,
                text: `Hello ${writer?.name || 'Writer'},\n\nAn administrator approved your submission for order ${id}. The order is now complete, and the customer has been notified that the work is ready.\n\nSign in to view the completed assignment and its current status.`,
                action: { label: 'View Completed Work', path: emailPaths(id).writerAssignment },
                idempotencyKey: `writer-review/${id}/${data.submissionId}/approved`,
            });
            await sendWorkflowEmail({
                event: 'approved_work_delivered',
                to: completedOrder.email,
                subject: `Your completed order is ready: ${completedOrder.orderId}`,
                text: `Hello ${completedOrder.userName},\n\nThe work for order ${completedOrder.orderId} has been approved and is ready in your account. Sign in with the account used to place the order to view the order details and access the completed work.`,
                action: { label: 'View Completed Work', path: emailPaths(completedOrder.orderId).trackOrder },
                idempotencyKey: `approved-work-delivered/${completedOrder.orderId}/${data.submissionId}`,
            });
            return NextResponse.json({
                success: true,
                orderId: completedOrder.orderId,
                orderStatus: completedOrder.orderStatus,
                physicalDeliveryStatus: completedOrder.physicalDeliveryStatus,
                deliveryFile: completedOrder.deliveryFile,
                completedAt: completedOrder.completedAt,
                workflowStatus: completedOrder.writerWorkflowStatus,
                currentSubmissionId: completedOrder.currentWriterSubmissionId,
                approvedSubmissionId: completedOrder.approvedSubmissionId,
            }, { headers: { 'Cache-Control': 'private, no-store' } });
        }

        const changed = await OrderModel.findOneAndUpdate(filter as any, {
            $set: {
                writerWorkflowStatus: 'revision_required',
                [`writerSubmissions.$[selected].reviewStatus`]: 'revision_required',
                [`writerSubmissions.$[selected].reviewedAt`]: now,
                [`writerSubmissions.$[selected].reviewedByAdminId`]: session.sub,
                [`writerSubmissions.$[selected].reviewFeedback`]: feedback,
            },
        }, {
            new: true,
            arrayFilters: [{
                'selected.submissionId': data.submissionId,
                'selected.assignmentVersion': data.assignmentVersion,
                'selected.reviewStatus': 'pending_review',
            }],
        }).select('orderId orderStatus writerWorkflowStatus currentWriterSubmissionId approvedSubmissionId').lean();
        if (!changed) {
            return NextResponse.json({ error: 'This submission is stale, already decided, or no longer assigned to its writer. Refresh the review data.' }, { status: 409 });
        }
        await sendWorkflowEmail({
            event: 'writer_revision_requested',
            to: writer?.email,
            subject: `Revision feedback for order ${id}`,
            text: `Hello ${writer?.name || 'Writer'},\n\nAn administrator reviewed your submission for order ${id} and requested a revision. Please read the feedback in your assignment workspace, update the work, and submit it again.\n\nFeedback:\n${feedback}`,
            action: { label: 'Review Feedback', path: emailPaths(id).writerAssignment },
            idempotencyKey: `writer-review/${id}/${data.submissionId}/revision_required`,
        });
        return NextResponse.json({
            success: true,
            orderId: changed.orderId,
            orderStatus: changed.orderStatus,
            workflowStatus: changed.writerWorkflowStatus,
            currentSubmissionId: changed.currentWriterSubmissionId,
            approvedSubmissionId: changed.approvedSubmissionId,
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Admin submission decision error:', error);
        return NextResponse.json({ error: 'Could not save the review decision' }, { status: 500 });
    }
}
