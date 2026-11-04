import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';
import UserModel from '@/lib/models/User';

export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        await connectDB();
        const currentRows = await OrderModel.aggregate([
            { $match: {
                writerWorkflowStatus: 'submitted_for_review',
                currentWriterSubmissionId: { $exists: true, $ne: '' },
                assignedWriterId: { $exists: true },
                assignmentStatus: 'accepted',
            } },
            { $unwind: '$writerSubmissions' },
            { $match: { 'writerSubmissions.reviewStatus': 'pending_review' } },
            { $match: { $expr: { $and: [
                { $eq: ['$writerSubmissions.submissionId', '$currentWriterSubmissionId'] },
                { $eq: ['$writerSubmissions.writerId', '$assignedWriterId'] },
                { $eq: ['$writerSubmissions.assignmentVersion', '$assignmentVersion'] },
            ] } } },
            { $sort: { 'writerSubmissions.submittedAt': 1 } },
            { $project: {
                orderId: 1,
                orderStatus: 1,
                userName: 1,
                collegeName: 1,
                yearOfStudying: 1,
                branch: 1,
                submissionId: '$writerSubmissions.submissionId',
                writerId: '$writerSubmissions.writerId',
                assignmentVersion: '$writerSubmissions.assignmentVersion',
                submittedAt: '$writerSubmissions.submittedAt',
                fileId: '$writerSubmissions.fileId',
            } },
        ]);
        const writerIds = [...new Set(currentRows.map((row) => row.writerId))];
        const writers = await UserModel.find({ _id: { $in: writerIds }, role: { $in: ['writer', 'user'] }, applicationStatus: 'approved' }).select('_id name email').lean();
        const writersById = new Map(writers.map((writer) => [writer._id.toString(), writer]));

        return NextResponse.json(currentRows.map((row) => ({
            orderId: row.orderId,
            orderStatus: row.orderStatus,
            customer: {
                name: row.userName,
                collegeName: row.collegeName,
                yearOfStudying: row.yearOfStudying,
                branch: row.branch,
            },
            submissionId: row.submissionId,
            assignmentVersion: row.assignmentVersion,
            submittedAt: row.submittedAt,
            fileUrl: `/api/files/${encodeURIComponent(row.fileId)}`,
            writer: writersById.get(row.writerId)
                ? { id: row.writerId, name: writersById.get(row.writerId)!.name, email: writersById.get(row.writerId)!.email }
                : { id: row.writerId, name: 'Writer account unavailable', email: '' },
        })), { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Admin submission queue error:', error);
        return NextResponse.json({ error: 'Could not load the submission queue' }, { status: 500 });
    }
}
