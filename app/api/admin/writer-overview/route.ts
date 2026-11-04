import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getWriterPerformance, getWriterWorkloadLabel, getWriterWorkloads } from '@/lib/db';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';
import OrderModel from '@/lib/models/Order';
import { expirePendingWriterAssignments } from '@/lib/assignment-expiration';

export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        await connectDB();
        await expirePendingWriterAssignments();
        const writers = await UserModel.find({
            role: { $in: ['writer', 'user'] },
            applicationStatus: 'approved',
        })
            .select('_id name email applicationStatus isAvailable createdAt')
            .sort({ name: 1, email: 1 })
            .lean();
        const ids = writers.map((writer) => writer._id.toString());
        const [workloads, performance] = await Promise.all([
            getWriterWorkloads(ids),
            getWriterPerformance(ids),
        ]);
        const pendingOrders = await OrderModel.find({
            assignedWriterId: { $in: ids },
            assignmentStatus: 'pending_acceptance',
        }).select('orderId assignedWriterId assignmentResponseDeadline').lean();
        const pendingByWriter = new Map<string, Array<{ orderId: string; responseDeadline?: string }>>();
        for (const order of pendingOrders) {
            const writerId = order.assignedWriterId?.toString();
            if (!writerId) continue;
            const items = pendingByWriter.get(writerId) || [];
            items.push({ orderId: order.orderId, responseDeadline: order.assignmentResponseDeadline });
            pendingByWriter.set(writerId, items);
        }

        return NextResponse.json(writers.map((writer) => {
            const id = writer._id.toString();
            const isAvailable = writer.isAvailable === true;
            const workload = workloads.get(id) || { activeOrderCount: 0, activeOrderIds: [] };
            const pendingAssignments = pendingByWriter.get(id) || [];
            const metrics = performance.get(id);
            return {
                id,
                name: writer.name,
                email: writer.email,
                createdAt: writer.createdAt,
                applicationStatus: writer.applicationStatus || 'pending',
                isAvailable,
                activeOrderCount: workload.activeOrderCount,
                activeOrderIds: workload.activeOrderIds,
                pendingAcceptanceCount: pendingAssignments.length,
                pendingAssignments,
                workloadLabel: getWriterWorkloadLabel(isAvailable, workload.activeOrderCount),
                performance: metrics,
            };
        }), { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer overview error:', error);
        return NextResponse.json({ error: 'Could not load writer overview' }, { status: 500 });
    }
}
