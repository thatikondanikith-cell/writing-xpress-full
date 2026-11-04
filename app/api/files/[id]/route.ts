import { NextRequest, NextResponse } from 'next/server';
import { downloadFileFromGridFS } from '@/lib/gridfs';
import { getAcceptedOrderByWriterFileReference, getOrderByFileReference, getOrderById } from '@/lib/db';
import { getSession, hasWriterSession, verifyDeliveryDownloadToken } from '@/lib/auth';
import { getOrderOwnerEmail } from '@/lib/customer-order-ownership';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';
import path from 'path';
import fs from 'fs';
import { createSafeContentDisposition, getValidatedMimeType } from '@/lib/file-types';

// Validate that a string is a valid 24-char hex MongoDB ObjectId
function isValidObjectId(id: string): boolean {
    return /^[a-f\d]{24}$/i.test(id);
}

// GET /api/files/[id] — streams an order-linked file after authorization.
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const session = getSession(request);
        const token = request.nextUrl.searchParams.get('token');
        const downloadClaims = token ? verifyDeliveryDownloadToken(token) : null;
        const writerSession = Boolean(session && hasWriterSession(session));

        if (!session && !downloadClaims) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (session && session.role !== 'admin' && session.role !== 'user' && session.role !== 'writer') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        if (writerSession && downloadClaims && session?.role === 'writer') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        if (downloadClaims && downloadClaims.fileId !== id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        let writerIsApproved = false;
        if (writerSession && session) {
            if (!/^[a-f\d]{24}$/i.test(session.sub)) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
            await connectDB();
            const writer = await UserModel.findOne({
                _id: session.sub,
                role: { $in: ['writer', 'user'] },
                applicationStatus: 'approved',
            })
                .select('_id').lean();
            if (!writer && session.role === 'writer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            writerIsApproved = Boolean(writer);
        }

        const order = writerIsApproved && writerSession && session
            ? await getAcceptedOrderByWriterFileReference(session.sub, id)
            : downloadClaims
                ? await getOrderById(downloadClaims.orderId)
                : await getOrderByFileReference(id);

        if (!order) {
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }

        const isAdmin = session?.role === 'admin';
        const isTokenOwner = Boolean(
            downloadClaims &&
            getOrderOwnerEmail(order) === downloadClaims.email.toLowerCase().trim() &&
            order.orderStatus === 'Completed' &&
            order.deliveryFile === id
        );
        const isSessionOwner = Boolean(
            session?.role === 'user' &&
            getOrderOwnerEmail(order) === session.email.toLowerCase().trim() &&
            order.orderStatus === 'Completed' &&
            order.deliveryFile === id
        );
        const isCurrentWriter = Boolean(
            writerIsApproved && writerSession && session &&
            order.assignedWriterId === session.sub &&
            (order.assignmentStatus === 'accepted' || !order.assignmentStatus) &&
            (
                order.uploadedFiles.includes(id) ||
                order.writerSubmissions?.some((submission) =>
                    submission.fileId === id &&
                    submission.writerId === session.sub &&
                    submission.assignmentVersion === (order.assignmentVersion || 0)
                ) === true
            )
        );

        if (!isAdmin && !isTokenOwner && !isSessionOwner && !isCurrentWriter) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // --- Legacy fallback: serve files stored before GridFS migration ---
        if (!isValidObjectId(id)) {
            // Legacy files remain in public/uploads for compatibility, but proxy.ts
            // blocks direct static access to that directory.
            const safeFilename = path.basename(id);
            if (safeFilename !== id || id.includes('\\') || id.includes('/')) {
                return NextResponse.json({ error: 'File not found' }, { status: 404 });
            }
            const headerFilename = safeFilename.replace(/[\r\n"]/g, '_');
            const legacyPath = path.join(process.cwd(), 'public', 'uploads', safeFilename);

            if (fs.existsSync(legacyPath)) {
                const buffer = fs.readFileSync(legacyPath);
                return new NextResponse(new Uint8Array(buffer), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Disposition': createSafeContentDisposition(headerFilename, 'attachment'),
                        'Content-Length': buffer.length.toString(),
                        'Cache-Control': 'private, no-store',
                        'Referrer-Policy': 'no-referrer',
                        'X-Content-Type-Options': 'nosniff',
                    },
                });
            }

            return NextResponse.json(
                { error: 'File not found.' },
                { status: 404 }
            );
        }

        // --- GridFS: serve files stored after migration ---
        const { buffer, filename, validationVersion, validatedContentType } = await downloadFileFromGridFS(id);
        const contentType = getValidatedMimeType(filename, validationVersion, validatedContentType) || 'application/octet-stream';
        const isValidatedPdf = contentType === 'application/pdf';

        return new NextResponse(new Uint8Array(buffer), {
            status: 200,
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': createSafeContentDisposition(filename, isValidatedPdf ? 'inline' : 'attachment'),
                'Content-Length': buffer.length.toString(),
                'Cache-Control': 'private, no-store',
                'Referrer-Policy': 'no-referrer',
                'X-Content-Type-Options': 'nosniff',
            },
        });

    } catch (error: any) {
        console.error('File fetch error:', error);
        if (error.message === 'File not found in GridFS') {
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        return NextResponse.json({ error: 'Failed to retrieve file' }, { status: 500 });
    }
}
