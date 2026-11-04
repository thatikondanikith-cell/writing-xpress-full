import mongoose from 'mongoose';
import FileRetentionTask, { type FileRetentionReason } from '@/lib/models/FileRetentionTask';
import OrderModel from '@/lib/models/Order';
import { connectDB } from '@/lib/mongoose';

const RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const TASK_BATCH_SIZE = 200;
const LEGACY_CUSTOMER_UPLOAD = /^\d{13}-/;

type RetentionTask = {
    _id: mongoose.Types.ObjectId;
    fileId: mongoose.Types.ObjectId;
    reason: FileRetentionReason;
    sourceOrderId?: mongoose.Types.ObjectId;
    eligibleAt: Date;
    attempts: number;
};

type CleanupOutcome = 'deleted' | 'ineligible' | 'shared';

export async function initializeFileRetentionTaskStore() {
    await FileRetentionTask.init();
}

function getDatabase() {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database not connected');
    return db;
}

function fileReferenceFilter(fileId: mongoose.Types.ObjectId) {
    const id = fileId.toString();
    return {
        $or: [
            { uploadedFiles: id },
            { deliveryFile: id },
            { 'writerSubmissions.fileId': id },
        ],
    };
}

async function enqueueTask(input: {
    fileId: mongoose.Types.ObjectId;
    reason: FileRetentionReason;
    eligibleAt: Date;
    sourceOrderId?: mongoose.Types.ObjectId;
}, session?: mongoose.ClientSession) {
    try {
        if (session) {
            const retained = await FileRetentionTask.findOne({ fileId: input.fileId, state: 'retained-shared' })
                .session(session).select('_id').lean();
            if (retained) return;
        }
        await FileRetentionTask.updateOne(
            { fileId: input.fileId, state: { $ne: 'retained-shared' } },
            {
                $set: {
                    reason: input.reason,
                    eligibleAt: input.eligibleAt,
                    state: 'pending',
                    ...(input.sourceOrderId ? { sourceOrderId: input.sourceOrderId } : { sourceOrderId: null }),
                },
                $setOnInsert: { fileId: input.fileId, createdAt: new Date(), attempts: 0 },
            },
            { upsert: true, ...(session ? { session } : {}) }
        );
    } catch (error) {
        // A concurrent non-transactional enqueue may collide with the unique
        // fileId index. Transactional callers propagate the error so their
        // order update can roll back with the task write.
        if (session || !(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
    }
}

/** Schedule an unreferenced replaced delivery file after a conservative 15-day grace period. */
export async function scheduleReplacedDeliveryFileCleanup(
    fileId: string,
    session: mongoose.ClientSession,
    scheduledAt = new Date()
) {
    if (!mongoose.isValidObjectId(fileId)) return;
    await enqueueTask({
        fileId: new mongoose.Types.ObjectId(fileId),
        reason: 'replaced-delivery',
        eligibleAt: new Date(scheduledAt.getTime() + RETENTION_MS),
    }, session);
}

/** Schedule conservative cleanup for an uploaded writer submission that may not be attached. */
export async function scheduleWriterSubmissionOrphanCleanup(fileId: string, scheduledAt = new Date()) {
    if (!mongoose.isValidObjectId(fileId)) return;
    await enqueueTask({
        fileId: new mongoose.Types.ObjectId(fileId),
        reason: 'orphaned-writer-submission',
        eligibleAt: new Date(scheduledAt.getTime() + RETENTION_MS),
    });
}

async function enqueueCompletedOrderFiles(cutoff: Date) {
    const cutoffIso = cutoff.toISOString();
    const gridFsFiles = getDatabase().collection('uploads.files');
    const cursor = OrderModel.find({ orderStatus: 'Completed', completedAt: { $lte: cutoffIso } })
        .select('_id completedAt uploadedFiles deliveryFile writerSubmissions.fileId')
        .lean()
        .cursor();
    let ordersScanned = 0;
    let referencesQueued = 0;
    for await (const order of cursor) {
        ordersScanned += 1;
        const completedAt = typeof order.completedAt === 'string' ? new Date(order.completedAt) : null;
        if (!completedAt || !Number.isFinite(completedAt.getTime()) || completedAt.getTime() > cutoff.getTime()) continue;
        const eligibleAt = new Date(completedAt.getTime() + RETENTION_MS);
        const values = [
            ...(order.uploadedFiles || []),
            ...(order.writerSubmissions || []).map((submission) => submission.fileId),
            ...(order.deliveryFile ? [order.deliveryFile] : []),
        ];
        const fileIds = [...new Set(values.filter((value) => typeof value === 'string' && mongoose.isValidObjectId(value)))];
        if (fileIds.length === 0) continue;
        const existingFiles = await gridFsFiles.find(
            { _id: { $in: fileIds.map((value) => new mongoose.Types.ObjectId(value)) } },
            { projection: { _id: 1 } }
        ).toArray();
        const existingIds = new Set(existingFiles.map((file) => file._id.toString()));
        for (const value of fileIds.filter((fileId) => existingIds.has(fileId))) {
            await enqueueTask({
                fileId: new mongoose.Types.ObjectId(value),
                reason: 'completed-order',
                eligibleAt,
                sourceOrderId: order._id,
            });
            referencesQueued += 1;
        }
    }

    // Customer uploads created before purpose metadata was added use the
    // timestamp-prefixed filename written by the original upload route.
    const files = getDatabase().collection('uploads.files');
    const abandonedCursor = files.find({
        uploadDate: { $lte: cutoff },
        $or: [
            { 'metadata.purpose': 'customer-reference' },
            { 'metadata.purpose': 'writer-submission' },
            { filename: { $regex: LEGACY_CUSTOMER_UPLOAD } },
        ],
    }, { projection: { _id: 1, uploadDate: 1, 'metadata.purpose': 1 } });
    let abandonedCandidates = 0;
    for await (const file of abandonedCursor) {
        if (!(file._id instanceof mongoose.Types.ObjectId) || !(file.uploadDate instanceof Date)) continue;
        const isWriterSubmission = file.metadata?.purpose === 'writer-submission';
        if (isWriterSubmission && await OrderModel.exists(fileReferenceFilter(file._id))) continue;
        await enqueueTask({
            fileId: file._id,
            reason: isWriterSubmission ? 'orphaned-writer-submission' : 'abandoned-upload',
            eligibleAt: new Date(file.uploadDate.getTime() + RETENTION_MS),
        });
        abandonedCandidates += 1;
    }

    return { ordersScanned, referencesQueued, abandonedCandidates };
}

async function processTask(task: RetentionTask, now: Date): Promise<CleanupOutcome> {
    const dbSession = await mongoose.startSession();
    let outcome: CleanupOutcome = 'ineligible';
    try {
        const transactionOutcome = await dbSession.withTransaction(async (): Promise<CleanupOutcome> => {
            if (task.eligibleAt.getTime() > now.getTime()) return 'ineligible';

            const db = getDatabase();
            const files = db.collection('uploads.files');
            const chunks = db.collection('uploads.chunks');
            const file = await files.findOne({ _id: task.fileId }, { session: dbSession });

            if (task.reason === 'completed-order') {
                if (!task.sourceOrderId) return 'ineligible';
                const owner = await OrderModel.findOne({
                    _id: task.sourceOrderId,
                    orderStatus: 'Completed',
                    completedAt: { $lte: new Date(now.getTime() - RETENTION_MS).toISOString() },
                }).select('_id completedAt').session(dbSession).lean();
                if (!owner) return 'ineligible';
                const references = await OrderModel.find(fileReferenceFilter(task.fileId))
                    .select('_id').session(dbSession).lean();
                if (!references.some((reference) => reference._id.equals(task.sourceOrderId))) return 'ineligible';
                if (references.some((reference) => !reference._id.equals(task.sourceOrderId))) {
                    await FileRetentionTask.updateOne(
                        { _id: task._id, state: 'pending' },
                        { $set: { state: 'retained-shared', lastAttemptAt: now }, $inc: { attempts: 1 } },
                        { session: dbSession }
                    );
                    return 'shared';
                }
            } else if (task.reason === 'abandoned-upload') {
                if (file) {
                    const uploadDate = file.uploadDate instanceof Date ? file.uploadDate : null;
                    const isCustomerUpload = file.metadata?.purpose === 'customer-reference' ||
                        (typeof file.filename === 'string' && LEGACY_CUSTOMER_UPLOAD.test(file.filename));
                    if (!uploadDate || uploadDate.getTime() > now.getTime() - RETENTION_MS || !isCustomerUpload) return 'ineligible';
                }
                const reference = await OrderModel.exists(fileReferenceFilter(task.fileId)).session(dbSession);
                if (reference) return 'ineligible';
            } else if (task.reason === 'replaced-delivery') {
                if (file && file.metadata?.purpose && file.metadata.purpose !== 'delivery') return 'ineligible';
                const references = await OrderModel.find(fileReferenceFilter(task.fileId))
                    .select('_id').session(dbSession).lean();
                if (references.length > 0) {
                    await FileRetentionTask.updateOne(
                        { _id: task._id, state: 'pending' },
                        { $set: { state: 'retained-shared', lastAttemptAt: now }, $inc: { attempts: 1 } },
                        { session: dbSession }
                    );
                    return 'shared';
                }
            } else {
                if (file) {
                    const uploadDate = file.uploadDate instanceof Date ? file.uploadDate : null;
                    if (!uploadDate || uploadDate.getTime() > now.getTime() - RETENTION_MS ||
                        file.metadata?.purpose !== 'writer-submission') return 'ineligible';
                }
                const reference = await OrderModel.exists(fileReferenceFilter(task.fileId)).session(dbSession);
                if (reference) return 'ineligible';
            }

            // This write conflicts with the order-creation transaction's file
            // association write. The two operations cannot race past the final
            // reference check and leave a live order pointing at a deleted file.
            await files.updateOne(
                { _id: task.fileId },
                { $set: { 'metadata.retentionCleanupAt': now } },
                { session: dbSession }
            );
            await chunks.deleteMany({ files_id: task.fileId }, { session: dbSession });
            await files.deleteOne({ _id: task.fileId }, { session: dbSession });
            return 'deleted';
        });
        if (transactionOutcome) outcome = transactionOutcome;
    } finally {
        await dbSession.endSession();
    }

    if (outcome === 'deleted' || outcome === 'ineligible') {
        await FileRetentionTask.deleteOne({ _id: task._id, state: 'pending' });
    }
    return outcome;
}

/**
 * Enqueues expired file references and processes a bounded number per run.
 * File/chunk deletion is transactional and each pending task remains durable
 * when a transaction fails, so the next cron run can retry it.
 */
export async function cleanupExpiredFiles(now = new Date()) {
    await connectDB();
    await FileRetentionTask.init();
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    const discovered = await enqueueCompletedOrderFiles(cutoff);
    const tasks = await FileRetentionTask.find({ state: 'pending', eligibleAt: { $lte: now } })
        .sort({ createdAt: 1 })
        .limit(TASK_BATCH_SIZE)
        .lean<RetentionTask[]>();

    let deleted = 0;
    let sharedReferences = 0;
    let ineligible = 0;
    let failures = 0;
    for (const task of tasks) {
        try {
            const result = await processTask(task, now);
            if (result === 'deleted') deleted += 1;
            else if (result === 'shared') sharedReferences += 1;
            else ineligible += 1;
        } catch {
            failures += 1;
            await FileRetentionTask.updateOne(
                { _id: task._id, state: 'pending' },
                { $inc: { attempts: 1 }, $set: { lastAttemptAt: now } }
            );
        }
    }

    const pending = await FileRetentionTask.countDocuments({ state: 'pending' });
    return {
        ...discovered,
        tasksAttempted: tasks.length,
        deleted,
        sharedReferences,
        ineligible,
        failures,
        pending,
    };
}
