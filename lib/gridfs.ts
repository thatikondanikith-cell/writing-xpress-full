import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import { Readable } from 'stream';
import { connectDB } from './mongoose';
import { FILE_VALIDATION_VERSION } from './file-types';

export type GridFSFilePurpose = 'customer-reference' | 'writer-submission' | 'delivery';

let bucket: GridFSBucket | null = null;

export async function getGridFSBucket(): Promise<GridFSBucket> {
    await connectDB();

    if (!bucket) {
        const db = mongoose.connection.db;
        if (!db) throw new Error('Database not connected');
        bucket = new GridFSBucket(db, { bucketName: 'uploads' });
    }

    return bucket;
}

/**
 * Upload a file buffer to GridFS.
 * Returns the GridFS file ID as a string.
 */
export async function uploadFileToGridFS(
    buffer: Buffer,
    filename: string,
    mimeType: string,
    purpose: GridFSFilePurpose,
    extraMetadata: {
        customerUploadBatchId?: string;
        fileValidationVersion?: number;
        validatedContentType?: string;
    } = {}
): Promise<string> {
    const bucket = await getGridFSBucket();

    return new Promise((resolve, reject) => {
        const readable = Readable.from(buffer);
        const uploadStream = bucket.openUploadStream(filename, {
            metadata: {
                contentType: mimeType,
                purpose,
                ...extraMetadata,
            },
        });

        readable.pipe(uploadStream);

        let settled = false;
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            readable.destroy();
            uploadStream.destroy();
            void (async () => {
                try {
                    await bucket.delete(uploadStream.id);
                } catch (cleanupError) {
                    console.error('Could not clean up an incomplete GridFS upload:', cleanupError);
                }
                reject(error);
            })();
        };

        readable.on('error', fail);
        uploadStream.on('error', fail);
        uploadStream.on('finish', () => {
            if (settled) return;
            settled = true;
            resolve(uploadStream.id.toString());
        });
    });
}

/**
 * Download a file from GridFS by its ID.
 * Returns the file buffer and metadata.
 */
export async function downloadFileFromGridFS(fileId: string): Promise<{
    buffer: Buffer;
    filename: string;
    contentType: string;
    validationVersion?: number;
    validatedContentType?: string;
}> {
    const bucket = await getGridFSBucket();
    const { ObjectId } = mongoose.Types;

    const objectId = new ObjectId(fileId);

    // Get file metadata
    const files = await bucket.find({ _id: objectId }).toArray();
    if (!files || files.length === 0) {
        throw new Error('File not found in GridFS');
    }

    const fileMeta = files[0];

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const downloadStream = bucket.openDownloadStream(objectId);

        downloadStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        downloadStream.on('end', () => {
            resolve({
                buffer: Buffer.concat(chunks),
                filename: fileMeta.filename,
                contentType: fileMeta.metadata?.contentType || 'application/octet-stream',
                ...(fileMeta.metadata?.fileValidationVersion === FILE_VALIDATION_VERSION
                    ? { validationVersion: FILE_VALIDATION_VERSION }
                    : {}),
                ...(typeof fileMeta.metadata?.validatedContentType === 'string'
                    ? { validatedContentType: fileMeta.metadata.validatedContentType }
                    : {}),
            });
        });
        downloadStream.on('error', reject);
    });
}

/** Return non-content metadata for a stored reference file. */
export async function getGridFSFileMetadata(fileId: string): Promise<{
    filename: string;
    contentType: string;
    length: number;
    uploadDate?: Date;
    validationVersion?: number;
    validatedContentType?: string;
}> {
    if (!/^[a-f\d]{24}$/i.test(fileId)) throw new Error('File not found in GridFS');
    const bucket = await getGridFSBucket();
    const fileMeta = (await bucket.find({ _id: new mongoose.Types.ObjectId(fileId) }).limit(1).toArray())[0];
    if (!fileMeta) throw new Error('File not found in GridFS');
    return {
        filename: fileMeta.filename,
        contentType: typeof fileMeta.metadata?.contentType === 'string'
            ? fileMeta.metadata.contentType
            : 'application/octet-stream',
        length: fileMeta.length,
        ...(fileMeta.metadata?.fileValidationVersion === FILE_VALIDATION_VERSION
            ? { validationVersion: FILE_VALIDATION_VERSION }
            : {}),
        ...(typeof fileMeta.metadata?.validatedContentType === 'string'
            ? { validatedContentType: fileMeta.metadata.validatedContentType }
            : {}),
        ...(fileMeta.uploadDate ? { uploadDate: fileMeta.uploadDate } : {}),
    };
}

/**
 * Delete a file from GridFS by its ID.
 */
export async function deleteFileFromGridFS(fileId: string): Promise<void> {
    const bucket = await getGridFSBucket();
    const { ObjectId } = mongoose.Types;
    await bucket.delete(new ObjectId(fileId));
}
