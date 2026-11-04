import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getSession, hasWriterSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import { uploadFileToGridFS } from '@/lib/gridfs';
import { scheduleWriterSubmissionOrphanCleanup } from '@/lib/file-retention';
import OrderModel from '@/lib/models/Order';
import UserModel from '@/lib/models/User';
import { getAdminNotificationEmail, sendWorkflowEmail } from '@/lib/email';
import { emailPaths } from '@/lib/email-template';
import {
    InvalidDocumentFileError,
    InvalidMultipartBodyError,
    parseMultipartFormDataWithinLimit,
    UploadBodyTooLargeError,
    validateDocumentFile,
} from '@/lib/file-validation';

type RouteContext = { params: Promise<{ id: string }> };
const MAX_SUBMISSION_BYTES = 25 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_SUBMISSION_BYTES + 1024 * 1024;
export async function POST(request: NextRequest, { params }: RouteContext) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (!hasWriterSession(session) || !mongoose.isValidObjectId(session.sub)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
            return NextResponse.json({ error: 'A multipart file submission is required' }, { status: 415 });
        }

        const { id } = await params;
        if (!/^WX-\d{8}-\d{4,}$/.test(id)) return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });

        let formData: FormData;
        try {
            formData = await parseMultipartFormDataWithinLimit(request, MAX_REQUEST_BYTES);
        } catch (error) {
            if (error instanceof UploadBodyTooLargeError) {
                return NextResponse.json({ error: 'Submission exceeds the 25 MiB file limit' }, { status: 413 });
            }
            if (error instanceof InvalidMultipartBodyError) {
                return NextResponse.json({ error: 'Invalid multipart file submission' }, { status: 400 });
            }
            throw error;
        }
        const allowedKeys = new Set(['assignmentVersion', 'submissionFile']);
        for (const [key] of formData.entries()) {
            if (!allowedKeys.has(key)) return NextResponse.json({ error: 'Invalid submission fields' }, { status: 400 });
        }
        const versionValues = formData.getAll('assignmentVersion');
        const files = formData.getAll('submissionFile');
        if (versionValues.length !== 1 || typeof versionValues[0] !== 'string' || !/^\d+$/.test(versionValues[0])) {
            return NextResponse.json({ error: 'A valid assignment version is required' }, { status: 400 });
        }
        const assignmentVersion = Number(versionValues[0]);
        if (!Number.isSafeInteger(assignmentVersion) || assignmentVersion < 0) {
            return NextResponse.json({ error: 'A valid assignment version is required' }, { status: 400 });
        }
        if (files.length !== 1 || !(files[0] instanceof File) || files[0].size === 0) {
            return NextResponse.json({ error: 'Choose one non-empty submission file' }, { status: 400 });
        }

        const file = files[0];
        if (file.size > MAX_SUBMISSION_BYTES) {
            return NextResponse.json({ error: 'Submission exceeds the 25 MiB file limit' }, { status: 413 });
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
                return NextResponse.json({ error: 'Only valid PDF, Word, and PowerPoint files are allowed' }, { status: 400 });
            }
            throw error;
        }

        await connectDB();
        const writer = await UserModel.findOne({
            _id: session.sub,
            role: { $in: ['writer', 'user'] },
            applicationStatus: 'approved',
        })
            .select('_id name email').lean();
        if (!writer) return NextResponse.json({ error: 'Approved writer access is required' }, { status: 403 });

        const order = await OrderModel.findOne({
            orderId: id,
            assignedWriterId: session.sub,
            assignmentVersion: assignmentVersion === 0 ? { $in: [0, null] } : assignmentVersion,
            assignmentStatus: assignmentVersion === 0 ? { $in: ['accepted', null] } : 'accepted',
            orderStatus: { $in: ['Submitted', 'In Progress'] },
            writerWorkflowStatus: { $in: ['not_started', 'assigned', 'revision_required', null] },
            $and: [{
                $or: [
                    { assignmentHistory: { $elemMatch: { writerId: session.sub, assignmentVersion, status: 'accepted' } } },
                    ...(assignmentVersion === 0 ? [{
                        assignmentVersion: { $in: [0, null] },
                        $or: [{ assignmentHistory: { $size: 0 } }, { assignmentHistory: { $exists: false } }],
                    }] : []),
                ],
            }],
        }).select('assignmentVersion').lean();
        if (!order) return NextResponse.json({ error: 'This accepted assignment is no longer available for submission' }, { status: 409 });

        const submissionId = new mongoose.Types.ObjectId().toString();
        const uploadedFileId = await uploadFileToGridFS(
            validatedFile.bytes,
            `writer-submission-${submissionId}-${validatedFile.filename}`,
            validatedFile.mimeType,
            'writer-submission',
            {
                fileValidationVersion: validatedFile.validationVersion,
                validatedContentType: validatedFile.mimeType,
            }
        );
        await scheduleWriterSubmissionOrphanCleanup(uploadedFileId);
        const submittedAt = new Date().toISOString();
        const versionFilter = assignmentVersion === 0 ? { $in: [0, null] } : assignmentVersion;
        const changed = await OrderModel.findOneAndUpdate({
            orderId: id,
            assignedWriterId: session.sub,
            assignmentVersion: versionFilter,
            assignmentStatus: assignmentVersion === 0 ? { $in: ['accepted', null] } : 'accepted',
            orderStatus: { $in: ['Submitted', 'In Progress'] },
            writerWorkflowStatus: { $in: ['not_started', 'assigned', 'revision_required', null] },
            $and: [{
                $or: [
                    { assignmentHistory: { $elemMatch: { writerId: session.sub, assignmentVersion, status: 'accepted' } } },
                    ...(assignmentVersion === 0 ? [{
                        assignmentVersion: { $in: [0, null] },
                        $or: [{ assignmentHistory: { $size: 0 } }, { assignmentHistory: { $exists: false } }],
                    }] : []),
                ],
            }],
        }, {
            $set: {
                assignmentStatus: 'accepted',
                assignmentVersion,
                writerWorkflowStatus: 'submitted_for_review',
                currentWriterSubmissionId: submissionId,
            },
            $push: {
                writerSubmissions: {
                    submissionId,
                    writerId: session.sub,
                    assignmentVersion,
                    fileId: uploadedFileId,
                    submittedAt,
                    reviewStatus: 'pending_review',
                },
            },
        }, { new: true }).select('currentWriterSubmissionId writerWorkflowStatus').lean();

        if (!changed) {
            // Keep the uploaded file through the orphan grace period. The
            // retention worker deletes it only if no order references it.
            return NextResponse.json({ error: 'The assignment changed or a submission is already awaiting review. Refresh and try again.' }, { status: 409 });
        }
        await sendWorkflowEmail({
            event: 'writer_submission_received',
            to: getAdminNotificationEmail(),
            subject: `A writer submission is ready for review: ${id}`,
            text: `A writer submitted work for order ${id}, and it is waiting for your review.\n\nWriter: ${writer.name} (${writer.email})\nSubmitted at: ${submittedAt}\n\nOpen the review page to inspect the submission and approve it or request a revision.`,
            action: { label: 'Review Submission', path: emailPaths(id).adminSubmission },
            idempotencyKey: `writer-submission-received/${id}/${submissionId}`,
        });
        return NextResponse.json({
            success: true,
            submissionId,
            submittedAt,
            writerWorkflowStatus: changed.writerWorkflowStatus,
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        // If the database outcome is ambiguous after a network error, retain the
        // file rather than risk deleting one that was committed to the order.
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer submission error:', error);
        return NextResponse.json({ error: 'Could not submit this file' }, { status: 500 });
    }
}
