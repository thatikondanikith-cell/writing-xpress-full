import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getSession, hasWriterSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import { expirePendingWriterAssignments } from '@/lib/assignment-expiration';
import OrderModel from '@/lib/models/Order';
import UserModel from '@/lib/models/User';
import { getAdminNotificationEmail, sendWorkflowEmail } from '@/lib/email';
import { emailPaths } from '@/lib/email-template';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
    const session = getSession(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!hasWriterSession(session) || !mongoose.isValidObjectId(session.sub)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    try {
        const { id } = await params;
        if (!/^WX-\d{8}-\d{4,}$/.test(id)) return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: 'Invalid assignment response' }, { status: 400 });
        }
        const data = body as Record<string, unknown>;
        if (Object.keys(data).some((key) => !['decision', 'assignmentVersion'].includes(key)) ||
            !['accepted', 'declined'].includes(String(data.decision)) ||
            !Number.isSafeInteger(data.assignmentVersion) || Number(data.assignmentVersion) < 1) {
            return NextResponse.json({ error: 'Invalid assignment response' }, { status: 400 });
        }

        await connectDB();
        const writer = await UserModel.findOne({
            _id: session.sub,
            role: { $in: ['writer', 'user'] },
            applicationStatus: 'approved',
        })
            .select('applicationStatus').lean();
        if (!writer) {
            return NextResponse.json({ error: 'Approved writer access is required' }, { status: 403 });
        }

        const version = Number(data.assignmentVersion);
        const current = await OrderModel.findOne({
            orderId: id,
            assignedWriterId: session.sub,
            assignmentVersion: version,
            assignmentStatus: 'pending_acceptance',
        }).select('assignmentResponseDeadline').lean();
        if (!current) return NextResponse.json({ error: 'This assignment is no longer pending or has changed' }, { status: 409 });

        const now = new Date();
        if (!current.assignmentResponseDeadline || Date.parse(current.assignmentResponseDeadline) <= now.getTime()) {
            await expirePendingWriterAssignments(now);
            return NextResponse.json({ error: 'The response deadline has passed; this assignment has expired' }, { status: 410 });
        }

        const accepted = data.decision === 'accepted';
        const nowIso = new Date().toISOString();
        const update = accepted
            ? {
                $set: {
                    assignmentStatus: 'accepted',
                    assignmentRespondedAt: nowIso,
                    orderStatus: 'In Progress',
                    'assignmentHistory.$[attempt].status': 'accepted',
                    'assignmentHistory.$[attempt].respondedAt': nowIso,
                },
            }
            : {
                $set: {
                    'assignmentHistory.$[attempt].status': 'declined',
                    'assignmentHistory.$[attempt].declinedAt': nowIso,
                    writerWorkflowStatus: 'not_started',
                },
                $unset: {
                    assignedWriterId: '',
                    assignedAt: '',
                    assignedByAdminId: '',
                    assignmentStatus: '',
                    assignmentResponseDeadline: '',
                    assignmentRespondedAt: '',
                    assignmentOverrideReason: '',
                    assignmentOverrideAt: '',
                    assignmentOverrideByAdminId: '',
                },
            };

        const changed = await OrderModel.findOneAndUpdate({
            orderId: id,
            assignedWriterId: session.sub,
            assignmentVersion: version,
            assignmentStatus: 'pending_acceptance',
            ...(accepted ? { orderStatus: 'Submitted' } : {}),
            assignmentResponseDeadline: { $gt: nowIso },
            assignmentHistory: { $elemMatch: {
                assignmentVersion: version,
                writerId: session.sub,
                status: 'pending_acceptance',
            } },
        }, update, {
            new: true,
            arrayFilters: [{
                'attempt.assignmentVersion': version,
                'attempt.writerId': session.sub,
                'attempt.status': 'pending_acceptance',
            }],
        }).select('orderId assignmentStatus assignmentResponseDeadline assignmentVersion').lean();

        if (!changed) return NextResponse.json({ error: 'The assignment changed or its deadline passed; refresh and try again' }, { status: 409 });
        if (!accepted) {
            await sendWorkflowEmail({
                event: 'assignment_declined',
                to: getAdminNotificationEmail(),
                subject: `Writer declined assignment: ${id}`,
                text: `The assigned writer declined order ${id}, so it will need another assignment decision.\n\nWriter account: ${session.email || session.sub}\nAssignment version: ${version}\n\nOpen the order to review its current assignment status.`,
                action: { label: 'Review Order', path: emailPaths(id).adminOrder },
                idempotencyKey: `assignment-declined/${id}/${version}`,
            });
        }
        return NextResponse.json({
            success: true,
            decision: data.decision,
            assignment: {
                orderId: changed.orderId,
                status: accepted ? 'accepted' : 'declined',
                version,
                responseDeadline: changed.assignmentResponseDeadline,
            },
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer assignment response error:', error);
        return NextResponse.json({ error: 'Could not update assignment response' }, { status: 500 });
    }
}
