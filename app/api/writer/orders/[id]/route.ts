import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getSession, hasWriterSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import { expirePendingWriterAssignments } from '@/lib/assignment-expiration';
import { getGridFSFileMetadata } from '@/lib/gridfs';
import OrderModel from '@/lib/models/Order';
import UserModel from '@/lib/models/User';

type RouteContext = { params: Promise<{ id: string }> };
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const ORDER_ID_PATTERN = /^WX-\d{8}-\d{4,}$/;

async function getReferenceFile(fileId: string) {
    const downloadUrl = `/api/files/${encodeURIComponent(fileId)}`;
    if (OBJECT_ID_PATTERN.test(fileId)) {
        try {
            const metadata = await getGridFSFileMetadata(fileId);
            return {
                id: fileId,
                filename: metadata.filename,
                contentType: metadata.contentType,
                size: metadata.length,
                uploadDate: metadata.uploadDate?.toISOString(),
                downloadUrl,
                available: true,
            };
        } catch {
            return { id: fileId, filename: 'Reference file', available: false };
        }
    }

    // Legacy uploads use their safe basename as the order's stored reference.
    const basename = path.basename(fileId);
    if (!basename || basename !== fileId || fileId.includes('/') || fileId.includes('\\')) {
        return { id: fileId, filename: 'Reference file', available: false };
    }
    try {
        const filePath = path.join(process.cwd(), 'public', 'uploads', basename);
        const info = await fs.stat(filePath);
        if (!info.isFile()) throw new Error('Not a file');
        return {
            id: fileId,
            filename: basename,
            contentType: 'application/octet-stream',
            size: info.size,
            downloadUrl,
            available: true,
        };
    } catch {
        return { id: fileId, filename: basename, available: false };
    }
}

export async function GET(request: NextRequest, { params }: RouteContext) {
    const session = getSession(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!hasWriterSession(session) || !mongoose.isValidObjectId(session.sub)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    try {
        const { id } = await params;
        if (!ORDER_ID_PATTERN.test(id)) return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });

        await connectDB();
        await expirePendingWriterAssignments();
        const writer = await UserModel.findOne({
            _id: session.sub,
            role: { $in: ['writer', 'user'] },
            applicationStatus: 'approved',
        })
            .select('_id').lean();
        if (!writer) return NextResponse.json({ error: 'Approved writer access is required' }, { status: 403 });

        const order = await OrderModel.findOne({ orderId: id, assignedWriterId: session.sub })
            .select('orderId orderStatus collegeName yearOfStudying branch instructions uploadedFiles createdDate assignedAt assignmentStatus assignmentResponseDeadline assignmentVersion assignmentRespondedAt writerWorkflowStatus currentWriterSubmissionId writerSubmissions')
            .lean();
        if (!order) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });

        const status = order.assignmentStatus || 'accepted';
        if (status !== 'pending_acceptance' && status !== 'accepted') {
            return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
        }

        const referenceFiles = status === 'accepted'
            ? await Promise.all((order.uploadedFiles || []).map((fileId) => getReferenceFile(fileId)))
            : [];
        const writerSubmissions = status === 'accepted'
            ? (order.writerSubmissions || [])
                .filter((submission) => submission.writerId === session.sub && submission.assignmentVersion === (order.assignmentVersion || 0))
                .map((submission) => ({
                    submissionId: submission.submissionId,
                    submittedAt: submission.submittedAt,
                    reviewStatus: submission.reviewStatus,
                    reviewedAt: submission.reviewedAt,
                    reviewFeedback: submission.reviewFeedback,
                    isCurrent: submission.submissionId === order.currentWriterSubmissionId,
                    fileUrl: `/api/files/${encodeURIComponent(submission.fileId)}`,
                }))
            : [];

        return NextResponse.json({
            order: {
                orderId: order.orderId,
                orderStatus: order.orderStatus,
                collegeName: order.collegeName,
                yearOfStudying: order.yearOfStudying,
                branch: order.branch,
                instructions: order.instructions,
                createdDate: order.createdDate,
            },
            assignment: {
                status,
                assignedAt: order.assignedAt,
                responseDeadline: status === 'pending_acceptance' ? order.assignmentResponseDeadline : undefined,
                respondedAt: status === 'accepted' ? order.assignmentRespondedAt : undefined,
                version: order.assignmentVersion || 0,
            },
            referenceFiles,
            referenceFileCount: order.uploadedFiles?.length || 0,
            writerWorkflowStatus: order.writerWorkflowStatus || 'assigned',
            currentSubmissionId: order.currentWriterSubmissionId || null,
            submissions: writerSubmissions,
            reviewWorkflowAvailable: true,
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer assignment detail lookup error:', error);
        return NextResponse.json({ error: 'Could not load assignment details' }, { status: 500 });
    }
}
