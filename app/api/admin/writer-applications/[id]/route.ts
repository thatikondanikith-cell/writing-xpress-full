import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';
import { sendWorkflowEmail } from '@/lib/email';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        const { id } = await params;
        if (!mongoose.isValidObjectId(id)) {
            return NextResponse.json({ error: 'Writer application not found' }, { status: 404 });
        }

        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }
        const decision = body.decision;
        if (decision !== 'approved' && decision !== 'rejected') {
            return NextResponse.json({ error: 'Decision must be approved or rejected' }, { status: 400 });
        }

        let rejectionReason: string | undefined;
        if (decision === 'rejected') {
            if (body.reason !== undefined && typeof body.reason !== 'string') {
                return NextResponse.json({ error: 'Rejection reason must be text' }, { status: 400 });
            }
            const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
            if (reason.length > 500) {
                return NextResponse.json({ error: 'Rejection reason must be 500 characters or fewer' }, { status: 400 });
            }
            rejectionReason = reason;
        }

        await connectDB();
        const update: Record<string, unknown> = {
            $set: {
                applicationStatus: decision,
                applicationReviewedAt: new Date().toISOString(),
                applicationReviewedBy: session.sub,
            },
        };
        if (decision === 'rejected' && rejectionReason) {
            (update.$set as Record<string, unknown>).applicationRejectionReason = rejectionReason;
        } else {
            update.$unset = { applicationRejectionReason: 1 };
        }

        const applicant = await UserModel.findOneAndUpdate(
            { _id: id, role: { $in: ['writer', 'user'] }, applicationStatus: 'pending' },
            update,
            { new: true, runValidators: true }
        ).select('_id name email role applicationStatus applicationReviewedAt applicationRejectionReason').lean();

        if (!applicant) {
            const existing = await UserModel.exists({
                _id: id,
                $or: [
                    { role: 'writer' },
                    { role: 'user', applicationStatus: { $in: ['pending', 'approved', 'rejected'] } },
                ],
            });
            if (!existing) return NextResponse.json({ error: 'Writer application not found' }, { status: 404 });
            return NextResponse.json({ error: 'Writer application has already been reviewed' }, { status: 409 });
        }

        await sendWorkflowEmail({
            event: 'writer_application_decision',
            to: applicant.email,
            subject: decision === 'approved' ? 'Your writer application was approved' : 'Your writer application was reviewed',
            text: decision === 'approved'
                ? `Hello ${applicant.name},\n\nAn administrator approved your WRITING-XPRESS writer application. Sign in to review your application status and open the writer workspace.`
                : `Hello ${applicant.name},\n\nAn administrator reviewed your WRITING-XPRESS writer application and it was not approved.${applicant.applicationRejectionReason ? `\n\nFeedback from the review:\n${applicant.applicationRejectionReason}` : ''}\n\nSign in to review your application status and any available next steps.`,
            action: { label: 'View Application Status', path: decision === 'approved' ? '/writer/dashboard' : '/writer/signup' },
            idempotencyKey: `writer-application-decision/${applicant._id.toString()}/${decision}`,
        });

        return NextResponse.json({
            id: applicant._id.toString(),
            name: applicant.name,
            email: applicant.email,
            applicationStatus: applicant.applicationStatus,
            applicationReviewedAt: applicant.applicationReviewedAt,
            rejectionReason: applicant.applicationRejectionReason,
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer application decision error:', error);
        return NextResponse.json({ error: 'Failed to review writer application' }, { status: 500 });
    }
}
