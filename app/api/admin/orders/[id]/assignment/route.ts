import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { getSession } from '@/lib/auth';
import { ACTIVE_WRITER_ORDER_STATUSES, getWriterPerformance, getWriterWorkloadLabel, getWriterWorkloads } from '@/lib/db';
import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';
import UserModel from '@/lib/models/User';
import { expirePendingWriterAssignments } from '@/lib/assignment-expiration';
import { sendWorkflowEmail } from '@/lib/email';
import { emailPaths } from '@/lib/email-template';

type RouteContext = { params: Promise<{ id: string }> };

function validOrderId(id: string): boolean {
    return /^WX-\d{8}-\d{4,}$/.test(id);
}

function unauthorized(request: NextRequest): NextResponse | null {
    const session = getSession(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return null;
}

async function getAssignmentData(orderId: string) {
    const order = await OrderModel.findOne({ orderId })
        .select('orderId orderStatus assignedWriterId assignedAt assignedByAdminId assignmentStatus assignmentResponseDeadline assignmentOverrideReason assignmentOverrideAt assignmentOverrideByAdminId assignmentVersion assignmentHistory')
        .lean();
    if (!order) return null;

    const writers = await UserModel.find({ role: { $in: ['writer', 'user'] }, applicationStatus: 'approved' })
        .select('_id name email isAvailable')
        .sort({ name: 1, email: 1 })
        .lean();
    const writerIds = writers.map((writer) => writer._id.toString());
    const [workloads, performance] = await Promise.all([
        getWriterWorkloads(writerIds),
        getWriterPerformance(writerIds),
    ]);
    const eligibleWriters = writers.map((writer) => {
        const id = writer._id.toString();
        const isAvailable = writer.isAvailable === true;
        const workload = workloads.get(id) || { activeOrderCount: 0, activeOrderIds: [] };
        const metrics = performance.get(id);
        return {
            id,
            name: writer.name,
            email: writer.email,
            isAvailable,
            activeOrderCount: workload.activeOrderCount,
            workloadLabel: getWriterWorkloadLabel(isAvailable, workload.activeOrderCount),
            performance: metrics,
        };
    });

    const assignedWriterId = order.assignedWriterId?.toString() || null;
    const assignedWriter = assignedWriterId
        ? await UserModel.findById(assignedWriterId).select('_id name email isAvailable applicationStatus').lean()
        : null;
    const completionAttemptMap = new Map<string, { writerId: string; assignmentVersion: number }>();
    for (const attempt of order.assignmentHistory || []) {
        const accepted = attempt.status === 'accepted' ||
            (attempt.status === 'reassigned' && Boolean(attempt.respondedAt));
        if (!accepted || !attempt.writerId || typeof attempt.assignmentVersion !== 'number' || !Number.isSafeInteger(attempt.assignmentVersion)) continue;
        const key = `${attempt.writerId}:${attempt.assignmentVersion}`;
        completionAttemptMap.set(key, { writerId: attempt.writerId, assignmentVersion: attempt.assignmentVersion });
    }
    // Pre-history assignments are retained only as an explicit admin attribution choice.
    const currentVersion = typeof order.assignmentVersion === 'number' && Number.isSafeInteger(order.assignmentVersion) ? order.assignmentVersion : 0;
    if (assignedWriterId && currentVersion === 0 && (order.assignmentStatus === 'accepted' || !order.assignmentStatus) && (order.assignmentHistory || []).length === 0) {
        const version = currentVersion;
        const key = `${assignedWriterId}:${version}`;
        completionAttemptMap.set(key, { writerId: assignedWriterId, assignmentVersion: version });
    }
    const completionAttempts = [...completionAttemptMap.values()]
        .filter((candidate) => mongoose.isValidObjectId(candidate.writerId));
    const completionWriters = await UserModel.find({ _id: { $in: [...new Set(completionAttempts.map((candidate) => candidate.writerId))] } })
        .select('_id name email').lean();
    const completionWriterById = new Map(completionWriters.map((writer) => [writer._id.toString(), writer]));
    const completionCandidates = completionAttempts.flatMap((candidate) => {
        const writer = completionWriterById.get(candidate.writerId);
        return writer ? [{ ...candidate, name: writer.name, email: writer.email }] : [];
    });
    return {
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        assignment: {
            writerId: assignedWriterId,
            writer: assignedWriter ? {
                id: assignedWriter._id.toString(),
                name: assignedWriter.name,
                email: assignedWriter.email,
                isAvailable: assignedWriter.isAvailable === true,
                applicationStatus: assignedWriter.applicationStatus || 'pending',
            } : null,
            assignedAt: order.assignedAt,
            assignedByAdminId: order.assignedByAdminId,
            // Phase 2 assignments are grandfathered as accepted work.
            status: order.assignmentStatus || (assignedWriterId ? 'accepted' : undefined),
            responseDeadline: order.assignmentResponseDeadline,
            overrideReason: order.assignmentOverrideReason,
            overrideAt: order.assignmentOverrideAt,
            overrideByAdminId: order.assignmentOverrideByAdminId,
            version: order.assignmentVersion || 0,
        },
        eligibleWriters,
        completionCandidates,
    };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
    try {
        const authError = unauthorized(request);
        if (authError) return authError;
        const { id } = await params;
        if (!validOrderId(id)) return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });

        await connectDB();
        await expirePendingWriterAssignments();
        const data = await getAssignmentData(id);
        if (!data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Order assignment lookup error:', error);
        return NextResponse.json({ error: 'Could not load assignment options' }, { status: 500 });
    }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        const { id } = await params;
        if (!validOrderId(id)) return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });

        let body: any;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
        }
        const allowedKeys = ['writerId', 'expectedWriterId', 'expectedAssignmentVersion', 'overrideUnavailable', 'overrideReason'];
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowedKeys.includes(key))) {
            return NextResponse.json({ error: 'Invalid assignment request' }, { status: 400 });
        }
        if (
            typeof body.writerId !== 'string' || !mongoose.isValidObjectId(body.writerId) ||
            !(body.expectedWriterId === null || (typeof body.expectedWriterId === 'string' && mongoose.isValidObjectId(body.expectedWriterId))) ||
            !Number.isSafeInteger(body.expectedAssignmentVersion) || body.expectedAssignmentVersion < 0 ||
            typeof body.overrideUnavailable !== 'boolean'
        ) {
            return NextResponse.json({ error: 'Invalid assignment request' }, { status: 400 });
        }

        const overrideReason = typeof body.overrideReason === 'string' ? body.overrideReason.trim() : '';
        if (body.overrideUnavailable && (overrideReason.length < 3 || overrideReason.length > 500)) {
            return NextResponse.json({ error: 'A reason of 3 to 500 characters is required for an unavailable-writer override' }, { status: 400 });
        }
        if (!body.overrideUnavailable && body.overrideReason !== undefined) {
            return NextResponse.json({ error: 'Override reason is only allowed with an override' }, { status: 400 });
        }

        await connectDB();
        await expirePendingWriterAssignments();
        const dbSession = await mongoose.startSession();
        let result: { assignment: Record<string, unknown> } | null = null;
        let assignedWriterName = '';
        let assignedWriterEmail = '';
        let committedResponseDeadline = '';
        try {
            await dbSession.withTransaction(async () => {
                const order = await OrderModel.findOne({ orderId: id }).session(dbSession)
                    .select('orderId orderStatus assignedWriterId assignedAt assignedByAdminId assignmentVersion').lean();
                if (!order) throw new AssignmentFailure(404, 'Order not found');

                if (!ACTIVE_WRITER_ORDER_STATUSES.includes(order.orderStatus as typeof ACTIVE_WRITER_ORDER_STATUSES[number])) {
                    throw new AssignmentFailure(409, 'Only Submitted or In Progress orders can be assigned');
                }
                const previousWriterId = order.assignedWriterId?.toString() || null;
                const currentVersion = order.assignmentVersion || 0;
                if (previousWriterId !== body.expectedWriterId || currentVersion !== body.expectedAssignmentVersion) {
                    throw new AssignmentFailure(409, 'The assignment changed. Refresh and try again.');
                }
                if (previousWriterId === body.writerId) {
                    throw new AssignmentFailure(409, 'This writer is already assigned to the order');
                }

                const candidate = await UserModel.findById(body.writerId).session(dbSession)
                    .select('_id name email role applicationStatus isAvailable').lean();
                if (!candidate) throw new AssignmentFailure(404, 'Writer account not found');
                if ((candidate.role !== 'writer' && candidate.role !== 'user') || candidate.applicationStatus !== 'approved') {
                    throw new AssignmentFailure(409, 'Only approved writer accounts can be assigned');
                }

                const isAvailable = candidate.isAvailable === true;
                if (!isAvailable && !body.overrideUnavailable) {
                    throw new AssignmentFailure(409, 'This writer is unavailable. Confirm an override to continue.');
                }
                if (isAvailable && body.overrideUnavailable) {
                    throw new AssignmentFailure(409, 'The unavailable-writer override is no longer applicable. Refresh and try again.');
                }

                // Touch the writer record in the transaction so availability/approval updates
                // conflict with assignment validation instead of using stale browser data.
                const lockedWriter = await UserModel.findOneAndUpdate(
                    {
                        _id: body.writerId,
                        role: { $in: ['writer', 'user'] },
                        applicationStatus: 'approved',
                        isAvailable: isAvailable ? true : { $ne: true },
                    },
                    { $inc: { assignmentValidationVersion: 1 } },
                    { new: true, session: dbSession }
                ).select('_id').lean();
                if (!lockedWriter) throw new AssignmentFailure(409, 'Writer eligibility changed. Refresh and try again.');

                const orderFilter: Record<string, unknown> = {
                    orderId: id,
                    orderStatus: { $in: ACTIVE_WRITER_ORDER_STATUSES },
                    assignedWriterId: previousWriterId,
                };
                if (currentVersion === 0) {
                    orderFilter.$or = [
                        { assignmentVersion: 0 },
                        { assignmentVersion: { $exists: false } },
                    ];
                } else {
                    orderFilter.assignmentVersion = currentVersion;
                }

                const assignedAt = new Date().toISOString();
                const responseDeadline = new Date(Date.parse(assignedAt) + 30 * 60 * 1000).toISOString();
                assignedWriterName = candidate.name;
                assignedWriterEmail = candidate.email;
                committedResponseDeadline = responseDeadline;
                const set: Record<string, unknown> = {
                    assignedWriterId: body.writerId,
                    assignedAt,
                    assignedByAdminId: session.sub,
                    assignmentStatus: 'pending_acceptance',
                    assignmentResponseDeadline: responseDeadline,
                    assignmentRespondedAt: null,
                    assignmentVersion: currentVersion + 1,
                    writerWorkflowStatus: 'assigned',
                };
                if (body.overrideUnavailable) {
                    set.assignmentOverrideReason = overrideReason;
                    set.assignmentOverrideAt = assignedAt;
                    set.assignmentOverrideByAdminId = session.sub;
                }
                const nextAttempt = {
                            writerId: body.writerId,
                            assignedAt,
                            assignedByAdminId: session.sub,
                            assignmentVersion: currentVersion + 1,
                            status: 'pending_acceptance',
                            responseDeadline,
                            ...(body.overrideUnavailable ? { overrideReason } : {}),
                };
                if (previousWriterId && order.assignedAt && order.assignedByAdminId) {
                    const previousAttemptUpdate = await OrderModel.updateOne({
                        ...orderFilter,
                        assignmentHistory: { $elemMatch: {
                            writerId: previousWriterId,
                            assignedAt: order.assignedAt,
                            assignedByAdminId: order.assignedByAdminId,
                        } },
                    }, {
                        $set: {
                            'assignmentHistory.$[previousAttempt].status': 'reassigned',
                            'assignmentHistory.$[previousAttempt].reassignedAt': assignedAt,
                            'assignmentHistory.$[previousAttempt].reassignedByAdminId': session.sub,
                        },
                    }, { session: dbSession, arrayFilters: [{
                        'previousAttempt.writerId': previousWriterId,
                        'previousAttempt.assignedAt': order.assignedAt,
                        'previousAttempt.assignedByAdminId': order.assignedByAdminId,
                    }] });
                    if (previousAttemptUpdate.modifiedCount !== 1) {
                        throw new AssignmentFailure(409, 'The current assignment history is inconsistent. Refresh before reassigning.');
                    }
                }
                const pipelineSet: Record<string, unknown> = {
                    ...set,
                    writerSubmissions: {
                        $map: {
                            input: { $ifNull: ['$writerSubmissions', []] },
                            as: 'submission',
                            in: {
                                $cond: [
                                    { $in: ['$$submission.reviewStatus', ['pending_review', 'revision_required']] },
                                    { $mergeObjects: ['$$submission', { reviewStatus: 'superseded', supersededAt: assignedAt }] },
                                    '$$submission',
                                ],
                            },
                        },
                    },
                    assignmentHistory: {
                        $concatArrays: [{ $ifNull: ['$assignmentHistory', []] }, [nextAttempt]],
                    },
                    currentWriterSubmissionId: '$$REMOVE',
                    approvedSubmissionId: '$$REMOVE',
                };
                if (!body.overrideUnavailable) {
                    pipelineSet.assignmentOverrideReason = '$$REMOVE';
                    pipelineSet.assignmentOverrideAt = '$$REMOVE';
                    pipelineSet.assignmentOverrideByAdminId = '$$REMOVE';
                }
                const updated = await OrderModel.findOneAndUpdate(orderFilter, [{ $set: pipelineSet }], {
                    new: true,
                    session: dbSession,
                    updatePipeline: true,
                }).select('assignedWriterId assignedAt assignedByAdminId assignmentStatus assignmentResponseDeadline assignmentOverrideReason assignmentOverrideAt assignmentOverrideByAdminId assignmentVersion').lean();
                if (!updated) throw new AssignmentFailure(409, 'The order changed during assignment. Refresh and try again.');

                result = {
                    assignment: {
                        writerId: updated.assignedWriterId?.toString(),
                        assignedAt: updated.assignedAt,
                        assignedByAdminId: updated.assignedByAdminId,
                        status: updated.assignmentStatus,
                        responseDeadline: updated.assignmentResponseDeadline,
                        overrideReason: updated.assignmentOverrideReason,
                        overrideAt: updated.assignmentOverrideAt,
                        overrideByAdminId: updated.assignmentOverrideByAdminId,
                        version: updated.assignmentVersion || 0,
                    },
                };
            });
        } finally {
            await dbSession.endSession();
        }

        const completedResult = result as { assignment: Record<string, unknown> } | null;
        if (!completedResult) throw new Error('Assignment transaction did not produce a result');
        const assignedVersion = Number(completedResult.assignment.version);
        await sendWorkflowEmail({
            event: 'order_assigned',
            to: assignedWriterEmail,
            subject: `A WRITING-XPRESS assignment is ready: ${id}`,
            text: `Hello ${assignedWriterName},\n\nAn administrator assigned order ${id} to you. Please review the brief and accept or decline by ${committedResponseDeadline}.\n\nSign in with your assigned writer account to respond.`,
            action: { label: 'View Assignment', path: emailPaths(id).writerAssignment },
            idempotencyKey: `order-assigned/${id}/${assignedVersion}`,
        });
        return NextResponse.json({ success: true, assignment: completedResult.assignment }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof AssignmentFailure) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        if (error instanceof Error && /transaction|replica set|mongos/i.test(error.message)) {
            console.error('Order assignment requires MongoDB transaction support:', error.message);
            return NextResponse.json({ error: 'Assignment requires a transaction-capable MongoDB deployment' }, { status: 503 });
        }
        const reference = randomUUID();
        console.error('Order assignment error:', { reference, error });
        return NextResponse.json({
            error: `An unexpected server error prevented assignment. Check the server log using reference ${reference} before retrying.`,
            reference,
        }, { status: 500 });
    }
}

class AssignmentFailure extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'AssignmentFailure';
    }
}
