import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';
import { getAdminNotificationEmail, sendWorkflowEmail } from '@/lib/email';
import { emailPaths } from '@/lib/email-template';

/**
 * Expire timed-out current assignment attempts. Every write is conditional on
 * the writer, attempt version, pending state, and deadline so a delayed sweep
 * cannot clear a reassignment or a writer response. Safe to call repeatedly.
 */
export async function expirePendingWriterAssignments(now = new Date()) {
    await connectDB();
    const cutoff = now.toISOString();
    const due = await OrderModel.find({
        assignmentStatus: 'pending_acceptance',
        assignmentResponseDeadline: { $lte: cutoff },
        assignedWriterId: { $exists: true },
        assignmentVersion: { $gt: 0 },
    })
        .select('orderId assignedWriterId assignmentVersion')
        .lean();

    if (due.length === 0) return { examined: 0, expired: 0 };

    const expiredAssignments: Array<{ orderId: string; writerId: string; assignmentVersion: number }> = [];
    for (const order of due) {
        if (!order.assignedWriterId || typeof order.assignmentVersion !== 'number' || !Number.isSafeInteger(order.assignmentVersion)) continue;
        const writerId = order.assignedWriterId.toString();
        const assignmentVersion = order.assignmentVersion;
        const changed = await OrderModel.findOneAndUpdate(
            {
                orderId: order.orderId,
                assignedWriterId: writerId,
                assignmentVersion,
                assignmentStatus: 'pending_acceptance',
                assignmentResponseDeadline: { $lte: cutoff },
                assignmentHistory: { $elemMatch: {
                    assignmentVersion: order.assignmentVersion,
                    writerId: order.assignedWriterId,
                    status: 'pending_acceptance',
                } },
            },
            {
                $set: {
                    'assignmentHistory.$[attempt].status': 'expired',
                    'assignmentHistory.$[attempt].expiredAt': cutoff,
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
            },
            {
                new: true,
                arrayFilters: [{
                'attempt.assignmentVersion': assignmentVersion,
                'attempt.writerId': writerId,
                'attempt.status': 'pending_acceptance',
                }],
            }
        ).select('orderId').lean();
        if (changed) {
            expiredAssignments.push({
                orderId: order.orderId,
                writerId,
                assignmentVersion,
            });
        }
    }

    const adminEmail = getAdminNotificationEmail();
    await Promise.all(expiredAssignments.map((assignment) => sendWorkflowEmail({
        event: 'assignment_expired',
        to: adminEmail,
        subject: `Writer response deadline passed: ${assignment.orderId}`,
        text: `The writer assigned to order ${assignment.orderId} did not respond before the acceptance deadline. The assignment has expired and needs administrator follow-up.\n\nWriter account ID: ${assignment.writerId}\nAssignment version: ${assignment.assignmentVersion}\n\nOpen the order to review its assignment status and choose the next step.`,
        action: { label: 'Review Order', path: emailPaths(assignment.orderId).adminOrder },
        idempotencyKey: `assignment-expired/${assignment.orderId}/${assignment.assignmentVersion}`,
    })));
    return { examined: due.length, expired: expiredAssignments.length };
}
