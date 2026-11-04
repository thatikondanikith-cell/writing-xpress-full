import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';
import { deleteFileFromGridFS, uploadFileToGridFS } from '@/lib/gridfs';
import { consumeUploadIpAllowance, getVercelClientIp } from '@/lib/otp-ip-rate-limit';
import CustomerUploadBatch from '@/lib/models/CustomerUploadBatch';
import { connectDB } from '@/lib/mongoose';
import {
    CUSTOMER_UPLOAD_BATCH_PURGE_MS,
    CUSTOMER_UPLOAD_TOKEN_TTL_MS,
    hashCustomerUploadToken,
    isValidCustomerEmail,
    normalizeCustomerEmail,
} from '@/lib/customer-upload';
import {
    InvalidDocumentFileError,
    InvalidMultipartBodyError,
    parseMultipartFormDataWithinLimit,
    UploadBodyTooLargeError,
    validateDocumentFile,
    type ValidatedDocumentFile,
} from '@/lib/file-validation';

const MIB = 1024 * 1024;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 3.5 * MIB;
const MAX_TOTAL_FILE_BYTES = 3.5 * MIB;
const MAX_REQUEST_BYTES = 4 * MIB;

function logUploadRejection(reason: string, details: Record<string, string | number> = {}) {
    // Fixed reason codes and small numeric indices only; never log request fields or file metadata.
    console.warn('[upload] request rejected', { reason, ...details });
}

export async function POST(request: NextRequest) {
    try {
        const clientIp = getVercelClientIp(request);
        if (!clientIp) {
            return NextResponse.json({ error: 'Upload service is temporarily unavailable. Please try again shortly.' }, { status: 503 });
        }
        const allowance = await consumeUploadIpAllowance(clientIp);
        if (allowance === 'limited') {
            return NextResponse.json({ error: 'Too many upload attempts. Please try again later.' }, { status: 429 });
        }
        if (allowance === 'unavailable') {
            return NextResponse.json({ error: 'Upload service is temporarily unavailable. Please try again shortly.' }, { status: 503 });
        }

        if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
            logUploadRejection('content_type_invalid');
            return NextResponse.json({ error: 'A multipart file upload is required.' }, { status: 415 });
        }

        let formData: FormData;
        try {
            formData = await parseMultipartFormDataWithinLimit(request, MAX_REQUEST_BYTES);
        } catch (error) {
            if (error instanceof UploadBodyTooLargeError) {
                logUploadRejection(error.reason);
                return NextResponse.json({ error: 'The upload request must be 4 MiB or smaller.' }, { status: 413 });
            }
            logUploadRejection(error instanceof InvalidMultipartBodyError ? error.reason : 'multipart_invalid');
            return NextResponse.json({ error: 'Invalid multipart upload request.' }, { status: 400 });
        }
        const emailValues = formData.getAll('email');
        if (emailValues.length !== 1 || typeof emailValues[0] !== 'string') {
            logUploadRejection('email_field_invalid');
            return NextResponse.json({ error: 'A valid customer email is required.' }, { status: 400 });
        }
        const email = normalizeCustomerEmail(emailValues[0]);
        if (!isValidCustomerEmail(email)) {
            logUploadRejection('email_invalid');
            return NextResponse.json({ error: 'A valid customer email is required.' }, { status: 400 });
        }
        const entries = formData.getAll('files');

        if (entries.length === 0) {
            logUploadRejection('files_missing');
            return NextResponse.json(
                { error: 'No files uploaded' },
                { status: 400 }
            );
        }
        if (entries.length > MAX_FILES) {
            logUploadRejection('file_count_exceeded');
            return NextResponse.json({ error: 'Upload up to 5 files at a time.' }, { status: 413 });
        }
        if (!entries.every((entry): entry is File => entry instanceof File)) {
            logUploadRejection('file_entry_invalid');
            return NextResponse.json({ error: 'Each upload entry must be a file.' }, { status: 400 });
        }
        const files = entries;
        if (files.some((file) => file.size > MAX_FILE_BYTES)) {
            logUploadRejection('single_file_size_exceeded');
            return NextResponse.json({ error: 'Each file must be 3.5 MiB or smaller.' }, { status: 413 });
        }
        if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_FILE_BYTES) {
            logUploadRejection('total_file_size_exceeded');
            return NextResponse.json({ error: 'Files must total no more than 3.5 MiB.' }, { status: 413 });
        }

        const validatedFiles: ValidatedDocumentFile[] = [];
        for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
            const file = files[fileIndex];
            try {
                validatedFiles.push(await validateDocumentFile({
                    filename: file.name,
                    declaredMimeType: file.type,
                    bytes: Buffer.from(await file.arrayBuffer()),
                }));
            } catch (error) {
                if (error instanceof InvalidDocumentFileError) {
                    logUploadRejection(error.reason, { fileIndex });
                    return NextResponse.json({ error: 'Only valid PDF, Word, and PowerPoint files are allowed.' }, { status: 400 });
                }
                throw error;
            }
        }

        const batchId = randomUUID();
        const uploadToken = randomBytes(32).toString('base64url');
        const uploadedIds: string[] = [];
        try {
            for (const file of validatedFiles) {
                // Use timestamp prefix to keep original filename readable
                const timestamp = Date.now();
                const storedFilename = `${timestamp}-${file.filename}`;

                const fileId = await uploadFileToGridFS(
                    file.bytes,
                    storedFilename,
                    file.mimeType,
                    'customer-reference',
                    {
                        customerUploadBatchId: batchId,
                        fileValidationVersion: file.validationVersion,
                        validatedContentType: file.mimeType,
                    }
                );
                uploadedIds.push(fileId);
            }

            const createdAt = new Date();
            await connectDB();
            await CustomerUploadBatch.create({
                batchId,
                tokenHash: hashCustomerUploadToken(uploadToken),
                fileIds: uploadedIds,
                email,
                expiresAt: new Date(createdAt.getTime() + CUSTOMER_UPLOAD_TOKEN_TTL_MS),
                purgeAt: new Date(createdAt.getTime() + CUSTOMER_UPLOAD_BATCH_PURGE_MS),
                createdAt,
            });
        } catch (uploadError) {
            try {
                await CustomerUploadBatch.deleteOne({ batchId });
            } catch (cleanupError) {
                console.error('Could not clean up a failed customer upload batch:', cleanupError);
            }
            for (const fileId of uploadedIds) {
                try {
                    await deleteFileFromGridFS(fileId);
                } catch (cleanupError) {
                    console.error('Could not clean up a failed customer upload file:', cleanupError);
                }
            }
            throw uploadError;
        }

        return NextResponse.json({
            success: true,
            files: uploadedIds, // returns GridFS ObjectId strings
            uploadToken,
        });

    } catch (error) {
        if (error instanceof UploadBodyTooLargeError) {
            logUploadRejection(error.reason);
            return NextResponse.json({ error: 'The upload request must be 4 MiB or smaller.' }, { status: 413 });
        }
        if (error instanceof InvalidMultipartBodyError) {
            logUploadRejection(error.reason);
            return NextResponse.json({ error: 'Invalid multipart upload request.' }, { status: 400 });
        }
        console.error('Upload error:', error);
        return NextResponse.json(
            { error: 'Failed to upload files' },
            { status: 500 }
        );
    }
}
