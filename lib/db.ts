import type { Order } from './types';
import mongoose from 'mongoose';
import { connectDB } from './mongoose';
import OrderModel from './models/Order';
import DailyOrderCounter from './models/DailyOrderCounter';
import CustomerUploadBatch from './models/CustomerUploadBatch';
import { scheduleReplacedDeliveryFileCleanup } from './file-retention';
import {
    fingerprintCustomerOrderRequest,
    hashCustomerUploadToken,
    isValidCustomerEmail,
    normalizeCustomerEmail,
} from './customer-upload';
import { getOrderOwnerEmail } from './customer-order-ownership';
import { canTransitionOrderStatus } from './order-lifecycle';

// These are the only active order states in the existing OrderStatus lifecycle.
export const ACTIVE_WRITER_ORDER_STATUSES = ['Submitted', 'In Progress'] as const;

export type WriterWorkload = {
    activeOrderCount: number;
    activeOrderIds: string[];
};

export type WriterPerformance = {
    rating: number;
    reviewCount: number;
    ratingIsProvisional: boolean;
    acceptanceRate: number | null;
    acceptedOffers: number;
    resolvedOffers: number;
    completionRate: number | null;
    completedAcceptedAssignments: number;
    acceptedAssignments: number;
    onTimeCompletionRate: null;
    onTimeCompletions: 0;
    deadlineEligibleCompletions: 0;
};

export class InvalidOrderFileReferencesError extends Error {
    constructor() {
        super('Invalid uploaded file references');
        this.name = 'InvalidOrderFileReferencesError';
    }
}

export class InvalidCustomerUploadBatchError extends Error {
    constructor() {
        super('Invalid, expired, or mismatched customer upload batch');
        this.name = 'InvalidCustomerUploadBatchError';
    }
}

export class CustomerUploadReplayConflictError extends Error {
    constructor() {
        super('Customer upload batch was already claimed by a different order request');
        this.name = 'CustomerUploadReplayConflictError';
    }
}

export class CustomerUploadBatchClaimConflictError extends Error {
    constructor() {
        super('Customer upload batch was claimed concurrently');
        this.name = 'CustomerUploadBatchClaimConflictError';
    }
}

function roundPercent(numerator: number, denominator: number): number | null {
    if (denominator === 0) return null;
    return Math.round((numerator / denominator) * 1000) / 10;
}

/** Server-derived writer rating and assignment outcome metrics. */
export async function getWriterPerformance(writerIds: string[]): Promise<Map<string, WriterPerformance>> {
    await connectDB();
    const result = new Map<string, WriterPerformance>();
    const stableIds = [...new Set(writerIds.filter((id) => mongoose.isValidObjectId(id)))];
    for (const id of stableIds) {
        result.set(id, {
            rating: 5,
            reviewCount: 0,
            ratingIsProvisional: true,
            acceptanceRate: null,
            acceptedOffers: 0,
            resolvedOffers: 0,
            completionRate: null,
            completedAcceptedAssignments: 0,
            acceptedAssignments: 0,
            onTimeCompletionRate: null,
            onTimeCompletions: 0,
            deadlineEligibleCompletions: 0,
        });
    }
    if (stableIds.length === 0) return result;

    const [ratings, attempts] = await Promise.all([
        OrderModel.aggregate([
            {
                $match: {
                    completedByWriterId: { $in: stableIds },
                    completedAssignmentVersion: { $exists: true },
                    orderStatus: 'Completed',
                    deliveryFile: { $exists: true, $nin: [null, ''] },
                    'customerReview.writerId': { $in: stableIds },
                    'customerReview.rating': { $gte: 1, $lte: 5 },
                    $expr: { $eq: ['$customerReview.writerId', '$completedByWriterId'] },
                },
            },
            {
                $group: {
                    _id: '$customerReview.writerId',
                    ratingSum: { $sum: '$customerReview.rating' },
                    reviewCount: { $sum: 1 },
                },
            },
        ]),
        OrderModel.aggregate([
            { $unwind: '$assignmentHistory' },
            {
                $match: {
                    'assignmentHistory.assignmentVersion': { $type: 'number' },
                    'assignmentHistory.writerId': { $in: stableIds },
                    'assignmentHistory.status': { $in: ['accepted', 'declined', 'expired', 'reassigned'] },
                },
            },
            {
                $group: {
                    _id: {
                        orderId: '$orderId',
                        assignmentVersion: '$assignmentHistory.assignmentVersion',
                    },
                    writerId: { $first: '$assignmentHistory.writerId' },
                    status: { $first: '$assignmentHistory.status' },
                    respondedAt: { $first: '$assignmentHistory.respondedAt' },
                    attemptCompletedAt: { $first: '$assignmentHistory.completedAt' },
                    orderStatus: { $first: '$orderStatus' },
                    deliveryFile: { $first: '$deliveryFile' },
                    completedByWriterId: { $first: '$completedByWriterId' },
                    completedAssignmentVersion: { $first: '$completedAssignmentVersion' },
                },
            },
            {
                $group: {
                    _id: '$writerId',
                    resolvedOffers: {
                        $sum: { $cond: [
                            { $or: [
                                { $in: ['$status', ['accepted', 'declined', 'expired']] },
                                { $and: [
                                    { $eq: ['$status', 'reassigned'] },
                                    { $ne: [{ $ifNull: ['$respondedAt', null] }, null] },
                                ] },
                            ] },
                            1,
                            0,
                        ] },
                    },
                    acceptedOffers: {
                        $sum: { $cond: [
                            { $or: [
                                { $eq: ['$status', 'accepted'] },
                                { $and: [
                                    { $eq: ['$status', 'reassigned'] },
                                    { $ne: [{ $ifNull: ['$respondedAt', null] }, null] },
                                ] },
                            ] },
                            1,
                            0,
                        ] },
                    },
                    completedAcceptedAssignments: {
                        $sum: { $cond: [
                            { $and: [
                                { $or: [
                                    { $eq: ['$status', 'accepted'] },
                                    { $and: [
                                        { $eq: ['$status', 'reassigned'] },
                                        { $ne: [{ $ifNull: ['$respondedAt', null] }, null] },
                                    ] },
                                ] },
                                { $ne: [{ $ifNull: ['$attemptCompletedAt', null] }, null] },
                                { $eq: ['$orderStatus', 'Completed'] },
                                { $ne: [{ $ifNull: ['$deliveryFile', null] }, null] },
                                { $eq: ['$completedByWriterId', '$writerId'] },
                                { $eq: ['$completedAssignmentVersion', '$_id.assignmentVersion'] },
                            ] },
                            1,
                            0,
                        ] },
                    },
                },
            },
        ]),
    ]);

    for (const item of ratings) {
        const id = String(item._id);
        const current = result.get(id);
        if (!current || item.reviewCount <= 0) continue;
        result.set(id, {
            ...current,
            rating: Math.round((item.ratingSum / item.reviewCount) * 10) / 10,
            reviewCount: item.reviewCount,
            ratingIsProvisional: false,
        });
    }
    for (const item of attempts) {
        const id = String(item._id);
        const current = result.get(id);
        if (!current) continue;
        result.set(id, {
            ...current,
            acceptanceRate: roundPercent(item.acceptedOffers, item.resolvedOffers),
            acceptedOffers: item.acceptedOffers,
            resolvedOffers: item.resolvedOffers,
            completionRate: roundPercent(item.completedAcceptedAssignments, item.acceptedOffers),
            completedAcceptedAssignments: item.completedAcceptedAssignments,
            acceptedAssignments: item.acceptedOffers,
        });
    }
    return result;
}

export function getWriterWorkloadLabel(isAvailable: boolean, activeOrderCount: number): string {
    const availability = isAvailable ? 'Available' : 'Unavailable';
    const work = activeOrderCount === 0
        ? 'No Active Orders'
        : `Working on ${activeOrderCount} ${activeOrderCount === 1 ? 'Order' : 'Orders'}`;
    return `${availability} — ${work}`;
}

// Workload is always derived from current assigned order records, never maintained separately.
export async function getWriterWorkloads(writerIds: string[]): Promise<Map<string, WriterWorkload>> {
    await connectDB();
    const result = new Map<string, WriterWorkload>();
    if (writerIds.length === 0) return result;

    const stableIds = [...new Set(writerIds.filter((id) => mongoose.isValidObjectId(id)))];
    if (stableIds.length === 0) return result;

    const workloads = await OrderModel.aggregate([
        {
            $match: {
                assignedWriterId: { $in: stableIds },
                $or: [
                    { assignmentStatus: 'accepted' },
                    // Phase 2 assignments predate acceptance; preserve them as active work.
                    { assignmentStatus: { $exists: false } },
                ],
                orderStatus: { $in: ACTIVE_WRITER_ORDER_STATUSES },
            },
        },
        {
            $group: {
                _id: '$assignedWriterId',
                activeOrderCount: { $sum: 1 },
                activeOrderIds: { $push: '$orderId' },
            },
        },
    ]);

    for (const workload of workloads) {
        result.set(workload._id.toString(), {
            activeOrderCount: workload.activeOrderCount,
            activeOrderIds: workload.activeOrderIds,
        });
    }
    return result;
}

export type WriterWorkspaceOrder = Pick<Order,
    'orderId' | 'orderStatus' | 'collegeName' | 'yearOfStudying' | 'branch' | 'createdDate' |
    'assignedAt' | 'assignmentStatus' | 'assignmentResponseDeadline' | 'assignmentRespondedAt' |
    'assignmentVersion' | 'writerWorkflowStatus'
>;

function normalizeWriterWorkspaceOrders(docs: any[]): WriterWorkspaceOrder[] {
    return docs.map((doc) => ({
        ...doc,
        // Existing Phase 2 assignments were already accepted operationally.
        assignmentStatus: doc.assignmentStatus || 'accepted',
    })) as WriterWorkspaceOrder[];
}

/** Return pending responses and accepted Submitted/In Progress assignments only. */
export async function getWriterCurrentAssignments(writerId: string): Promise<WriterWorkspaceOrder[]> {
    await connectDB();
    const docs = await OrderModel.find({
        assignedWriterId: writerId,
        $or: [
            { assignmentStatus: 'pending_acceptance' },
            { $and: [
                { orderStatus: { $in: ACTIVE_WRITER_ORDER_STATUSES } },
                { assignmentStatus: { $in: ['accepted', null, ''] } },
            ] },
        ],
    } as any)
        .select('orderId orderStatus collegeName yearOfStudying branch createdDate assignedAt assignmentStatus assignmentResponseDeadline assignmentRespondedAt assignmentVersion writerWorkflowStatus')
        .sort({ createdDate: -1, orderId: -1 })
        .lean();
    return normalizeWriterWorkspaceOrders(docs);
}

export async function getCompletedOrdersForWriter(
    writerId: string,
    options: { page: number; limit: number; search?: string; sort: 'newest' | 'oldest' }
): Promise<{ orders: WriterWorkspaceOrder[]; totalCount: number; page: number; limit: number }> {
    await connectDB();
    const filter: Record<string, unknown> = {
        assignedWriterId: writerId,
        orderStatus: 'Completed',
        assignmentStatus: { $in: ['accepted', null, ''] },
    };
    const search = options.search?.trim();
    if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
            { orderId: { $regex: escaped, $options: 'i' } },
            { collegeName: { $regex: escaped, $options: 'i' } },
            { yearOfStudying: { $regex: escaped, $options: 'i' } },
            { branch: { $regex: escaped, $options: 'i' } },
        ];
    }

    const totalCount = await OrderModel.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(totalCount / options.limit));
    const page = Math.min(options.page, totalPages);
    const direction = options.sort === 'newest' ? -1 : 1;
    const orders = await OrderModel.aggregate([
        { $match: filter },
        { $addFields: {
            __assignmentSortDate: {
                $ifNull: [
                    { $convert: { input: '$assignedAt', to: 'date', onError: null, onNull: null } },
                    { $convert: { input: '$createdDate', to: 'date', onError: null, onNull: null } },
                ],
            },
        } },
        { $sort: { __assignmentSortDate: direction, orderId: direction } },
        { $skip: (page - 1) * options.limit },
        { $limit: options.limit },
        { $project: {
            _id: 0,
            orderId: 1,
            orderStatus: 1,
            collegeName: 1,
            yearOfStudying: 1,
            branch: 1,
            createdDate: 1,
            assignedAt: 1,
            assignmentStatus: 1,
            assignmentResponseDeadline: 1,
            assignmentRespondedAt: 1,
            assignmentVersion: 1,
            writerWorkflowStatus: 1,
        } },
    ]);
    return { orders: normalizeWriterWorkspaceOrders(orders), totalCount, page, limit: options.limit };
}

// Helper to convert a Mongoose document to a plain Order object
function toOrder(doc: any): Order {
    const obj = doc.toObject ? doc.toObject() : doc;
    // Remove MongoDB internal fields
    const { _id, __v, ...rest } = obj;
    return rest as Order;
}

// Read all orders from database
export async function getAllOrders(): Promise<Order[]> {
    await connectDB();
    const docs = await OrderModel.find().sort({ createdDate: -1 }).lean();
    return docs.map((doc: any) => {
        const { _id, __v, ...rest } = doc;
        return rest as Order;
    });
}

export type AdminOrderDashboardQuery = {
    page: number;
    limit: number;
    search?: string;
    status?: 'All' | 'Submitted' | 'In Progress' | 'Completed';
    dateFrom?: string;
    dateTo?: string;
};

export type AdminOrderDashboardPage = {
    orders: Array<Pick<Order, 'orderId' | 'userName' | 'email' | 'collegeName' | 'orderStatus' | 'physicalDeliveryStatus' | 'createdDate'>>;
    totalCount: number;
    page: number;
    limit: number;
    summary: { total: number; submitted: number; inProgress: number; completed: number };
    unassignedOrders: Array<Pick<Order, 'orderId' | 'orderStatus' | 'collegeName'>>;
};

/** Fetch the admin dashboard's current page, global counts, and unassigned queue. */
export async function getAdminOrderDashboardPage(
    query: AdminOrderDashboardQuery
): Promise<AdminOrderDashboardPage> {
    await connectDB();

    const filter: Record<string, unknown> = {};
    if (query.status && query.status !== 'All') filter.orderStatus = query.status;
    if (query.dateFrom && query.dateTo) {
        filter.createdDate = { $gte: query.dateFrom, $lt: query.dateTo };
    }
    const search = query.search?.trim();
    if (search) {
        const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const contains = { $regex: escapedSearch, $options: 'i' };
        filter.$or = [
            { orderId: contains },
            { userName: contains },
            { email: contains },
            { collegeName: contains },
        ];
    }

    const [orders, totalCount, statusCounts, unassignedOrders] = await Promise.all([
        OrderModel.find(filter)
            .select('orderId userName email collegeName orderStatus physicalDeliveryStatus createdDate')
            .sort({ createdDate: -1, orderId: -1 })
            .skip((query.page - 1) * query.limit)
            .limit(query.limit)
            .lean(),
        OrderModel.countDocuments(filter),
        OrderModel.aggregate([
            { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
        ]),
        OrderModel.find({
            assignedWriterId: { $in: [null, ''] },
            orderStatus: { $in: ['Submitted', 'In Progress'] },
        })
            .select('orderId orderStatus collegeName')
            .sort({ createdDate: -1, orderId: -1 })
            .lean(),
    ]);

    const counts = new Map<string, number>(statusCounts.map((item: { _id: string; count: number }) => [item._id, item.count]));
    return {
        orders: orders as AdminOrderDashboardPage['orders'],
        totalCount,
        page: query.page,
        limit: query.limit,
        summary: {
            total: [...counts.values()].reduce((sum, count) => sum + count, 0),
            submitted: counts.get('Submitted') || 0,
            inProgress: counts.get('In Progress') || 0,
            completed: counts.get('Completed') || 0,
        },
        unassignedOrders: unassignedOrders as AdminOrderDashboardPage['unassignedOrders'],
    };
}

// Get order by ID
export async function getOrderById(orderId: string): Promise<Order | null> {
    await connectDB();
    const doc = await OrderModel.findOne({ orderId }).lean();
    if (!doc) return null;
    const { _id, __v, ...rest } = doc as any;
    return rest as Order;
}

// Find the order that owns a stored customer upload or delivery file reference.
export async function getOrderByFileReference(fileId: string): Promise<Order | null> {
    await connectDB();
    const doc = await OrderModel.findOne({
        $or: [{ uploadedFiles: fileId }, { deliveryFile: fileId }, { 'writerSubmissions.fileId': fileId }],
    }).lean();
    if (!doc) return null;
    const { _id, __v, ...rest } = doc as any;
    return rest as Order;
}

// Resolve a writer reference file only through an order currently assigned to that writer.
export async function getAcceptedOrderByWriterFileReference(writerId: string, fileId: string): Promise<Order | null> {
    await connectDB();
    const doc = await OrderModel.findOne({
        assignedWriterId: writerId,
        $or: [
            { assignmentStatus: 'accepted' },
            // Assignments created before Phase 3 were operationally accepted.
            { assignmentStatus: { $exists: false } },
        ],
        $and: [{
            $or: [
                { uploadedFiles: fileId },
                { writerSubmissions: { $elemMatch: { fileId, writerId } } },
            ],
        }],
    }).lean();
    if (!doc) return null;
    const { _id, __v, ...rest } = doc as any;
    return rest as Order;
}

class DailyOrderCounterInitializationConflictError extends Error {
    constructor() {
        super('Daily order counter was initialized concurrently');
        this.name = 'DailyOrderCounterInitializationConflictError';
    }
}

function isDuplicateKeyError(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 11000;
}

function hasErrorLabel(error: unknown, label: string): boolean {
    return !!error && typeof error === 'object' && 'hasErrorLabel' in error &&
        typeof error.hasErrorLabel === 'function' && error.hasErrorLabel(label);
}

async function getNextDailyOrderId(date: Date, session: mongoose.ClientSession): Promise<string> {
    const dateKey = date.toISOString().slice(0, 10).replace(/-/g, '');
    let counter = await DailyOrderCounter.findById(dateKey).session(session).lean();

    if (!counter) {
        const existingOrders = await OrderModel.find({ orderId: { $regex: `^WX-${dateKey}-` } })
            .select('orderId -_id')
            .session(session)
            .lean();
        let highestSequence = 0;
        for (const order of existingOrders) {
            const suffix = order.orderId.split('-')[2];
            const sequence = Number.parseInt(suffix, 10);
            if (Number.isSafeInteger(sequence)) highestSequence = Math.max(highestSequence, sequence);
        }

        try {
            await DailyOrderCounter.create([{ _id: dateKey, sequence: highestSequence }], { session });
        } catch (error) {
            // A concurrent first request may insert the same date key. Abort and
            // retry the transaction so its next attempt reads that counter.
            if (isDuplicateKeyError(error)) throw new DailyOrderCounterInitializationConflictError();
            throw error;
        }
    }

    const nextCounter = await DailyOrderCounter.findOneAndUpdate(
        { _id: dateKey },
        { $inc: { sequence: 1 } },
        { new: true, session, runValidators: true }
    ).lean();
    if (!nextCounter || !Number.isSafeInteger(nextCounter.sequence)) {
        throw new Error(`Invalid daily order counter for ${dateKey}`);
    }

    return `WX-${dateKey}-${String(nextCounter.sequence).padStart(4, '0')}`;
}

function isRetryableTransactionError(error: unknown): boolean {
    return hasErrorLabel(error, 'TransientTransactionError') ||
        error instanceof DailyOrderCounterInitializationConflictError;
}

// Create a new order
export async function createOrder(
    orderData: Omit<Order, 'orderId' | 'createdDate' | 'orderStatus'>,
    uploadToken: string,
    authenticatedOwnerEmail: string,
): Promise<{ order: Order; created: boolean }> {
    await connectDB();

    if (typeof uploadToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(uploadToken)) {
        throw new InvalidCustomerUploadBatchError();
    }
    const normalizedEmail = normalizeCustomerEmail(orderData.email);
    const normalizedOwnerEmail = normalizeCustomerEmail(authenticatedOwnerEmail);
    if (!isValidCustomerEmail(normalizedEmail) || !isValidCustomerEmail(normalizedOwnerEmail)) {
        throw new InvalidCustomerUploadBatchError();
    }

    const createdAt = new Date();
    const newOrderBase: Omit<Order, 'orderId'> = {
        ...orderData,
        ownerEmail: normalizedOwnerEmail,
        orderStatus: 'Submitted',
        createdDate: createdAt.toISOString(),
        physicalDeliveryStatus: 'Pending',
    };

    const normalizedFileIds = newOrderBase.uploadedFiles.map((fileId) =>
        typeof fileId === 'string' ? fileId.toLowerCase() : fileId
    );
    const fileIds = [...new Set(normalizedFileIds)];
    if (fileIds.length !== newOrderBase.uploadedFiles.length || fileIds.some((fileId) =>
        typeof fileId !== 'string' || !mongoose.isValidObjectId(fileId)
    )) {
        throw new InvalidOrderFileReferencesError();
    }
    newOrderBase.uploadedFiles = fileIds;

    newOrderBase.email = normalizedEmail;
    const tokenHash = hashCustomerUploadToken(uploadToken);
    const requestFingerprint = fingerprintCustomerOrderRequest(newOrderBase, fileIds, normalizedOwnerEmail);
    const batchFilter = { tokenHash };

    const matchesBatchRequest = (batch: any) =>
        batch && batch.email === normalizedEmail &&
        Array.isArray(batch.fileIds) && batch.fileIds.length === fileIds.length &&
        batch.fileIds.every((id: unknown, index: number) => id === fileIds[index]);

    const resolveClaimedBatch = async (session?: mongoose.ClientSession) => {
        let query = CustomerUploadBatch.findOne(batchFilter);
        if (session) query = query.session(session);
        const batch = await query.lean();
        if (!batch || new Date(batch.expiresAt).getTime() <= Date.now() || !matchesBatchRequest(batch)) {
            throw new InvalidCustomerUploadBatchError();
        }
        if (!batch.claimedOrderId) return null;
        if (batch.requestFingerprint !== requestFingerprint) throw new CustomerUploadReplayConflictError();
        let orderQuery = OrderModel.findOne({ orderId: batch.claimedOrderId });
        if (session) orderQuery = orderQuery.session(session);
        const existing = await orderQuery.lean();
        if (!existing || getOrderOwnerEmail(existing) !== normalizedOwnerEmail ||
            normalizeCustomerEmail(existing.email) !== normalizedEmail ||
            !Array.isArray(existing.uploadedFiles) || existing.uploadedFiles.length !== fileIds.length ||
            !existing.uploadedFiles.every((id: unknown, index: number) => id === fileIds[index])) {
            throw new CustomerUploadBatchClaimConflictError();
        }
        return { order: toOrder(existing), created: false };
    };

    const existing = await resolveClaimedBatch();
    if (existing) return existing;

    // Coordinate order attachment with file-retention cleanup. Both operations
    // write the GridFS files document, so one transaction must observe the other.
    // The daily counter is incremented here too, so a rollback does not consume an ID.
    const maxTransactionAttempts = 5;
    for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
        const dbSession = await mongoose.startSession();
        try {
            const result = await dbSession.withTransaction(async () => {
                const db = mongoose.connection.db;
                if (!db) throw new Error('Database not connected');
                const claimed = await resolveClaimedBatch(dbSession);
                if (claimed) return claimed;
                const batch = await CustomerUploadBatch.findOne({
                    ...batchFilter,
                    email: normalizedEmail,
                    expiresAt: { $gt: createdAt },
                    claimedOrderId: { $exists: false },
                }).session(dbSession).lean();
                if (!batch || !matchesBatchRequest(batch)) throw new InvalidCustomerUploadBatchError();
                const files = db.collection('uploads.files');
                const linkedAt = new Date();
                for (const fileId of fileIds) {
                    const updatedFile = await files.updateOne(
                        {
                            _id: new mongoose.Types.ObjectId(fileId),
                            'metadata.purpose': 'customer-reference',
                            'metadata.customerUploadBatchId': batch.batchId,
                            'metadata.claimedOrderId': { $exists: false },
                        },
                        { $set: { 'metadata.lastOrderReferenceAt': linkedAt, 'metadata.claimedOrderId': 'pending' } },
                        { session: dbSession }
                    );
                    if (updatedFile.matchedCount !== 1) throw new InvalidCustomerUploadBatchError();
                }
                const order: Order = {
                    ...newOrderBase,
                    orderId: await getNextDailyOrderId(createdAt, dbSession),
                };
                const batchClaim = await CustomerUploadBatch.updateOne(
                    { _id: batch._id, tokenHash, claimedOrderId: { $exists: false }, expiresAt: { $gt: createdAt } },
                    { $set: { claimedOrderId: order.orderId, claimedAt: linkedAt, requestFingerprint } },
                    { session: dbSession }
                );
                if (batchClaim.matchedCount !== 1) throw new CustomerUploadBatchClaimConflictError();
                for (const fileId of fileIds) {
                    const fileClaim = await files.updateOne(
                        { _id: new mongoose.Types.ObjectId(fileId), 'metadata.customerUploadBatchId': batch.batchId },
                        { $set: { 'metadata.claimedOrderId': order.orderId } },
                        { session: dbSession }
                    );
                    if (fileClaim.matchedCount !== 1) throw new InvalidCustomerUploadBatchError();
                }
                const [doc] = await OrderModel.create([order], { session: dbSession });
                return { order: toOrder(doc), created: true };
            });
            if (!result) throw new Error('Order creation transaction did not produce a result');
            return result;
        } catch (error) {
            try {
                const committed = await resolveClaimedBatch();
                if (committed) return committed;
            } catch (resolutionError) {
                if (resolutionError instanceof CustomerUploadReplayConflictError ||
                    resolutionError instanceof CustomerUploadBatchClaimConflictError ||
                    resolutionError instanceof InvalidCustomerUploadBatchError) throw resolutionError;
            }
            if (!isRetryableTransactionError(error) || attempt === maxTransactionAttempts) throw error;
        } finally {
            await dbSession.endSession();
        }
    }
    throw new Error('Order creation transaction retry limit exceeded');
}

// Update an existing order
export async function updateOrder(
    orderId: string,
    updates: Partial<Order>
): Promise<Order | null> {
    await connectDB();

    const doc = await OrderModel.findOneAndUpdate(
        { orderId },
        { $set: updates },
        { new: true } // return the updated document
    ).lean();

    if (!doc) return null;
    const { _id, __v, ...rest } = doc as any;
    return rest as Order;
}

/**
 * Apply the existing admin order update and atomically snapshot the explicitly
 * selected accepted assignment attempt when the order first has completed delivery.
 */
type SubmissionApprovalSnapshot = {
    submissionId: string;
    writerId: string;
    assignmentVersion: number;
    reviewedByAdminId: string;
};

export async function updateOrderWithCompletionSnapshot(
    orderId: string,
    updates: Partial<Order>,
    completionCandidate?: { writerId: string; assignmentVersion: number },
    requiredFilter?: Record<string, unknown>,
    replacedDeliveryFileId?: string,
    submissionApproval?: SubmissionApprovalSnapshot
): Promise<Order | null> {
    await connectDB();
    const requestedFields = Object.fromEntries(
        Object.entries(updates).map(([key, value]) => [key, { $literal: value }])
    );
    const resultingStatus = updates.orderStatus !== undefined ? { $literal: updates.orderStatus } : '$orderStatus';
    const resultingDelivery = updates.deliveryFile !== undefined ? { $literal: updates.deliveryFile } : '$deliveryFile';
    const hasResultingDelivery = {
        $and: [
            { $ne: [{ $ifNull: [resultingDelivery, ''] }, ''] },
            { $ne: [resultingDelivery, null] },
        ],
    };
    const alreadyCompletedWithDelivery = {
        $and: [
            { $eq: ['$orderStatus', 'Completed'] },
            { $ne: [{ $ifNull: ['$deliveryFile', ''] }, ''] },
        ],
    };
    const becomesReviewEligible = {
        $and: [
            { $eq: [resultingStatus, 'Completed'] },
            hasResultingDelivery,
            { $not: [alreadyCompletedWithDelivery] },
        ],
    };
    const noPreviousAttribution = { $eq: [{ $ifNull: ['$completedByWriterId', null] }, null] };
    const captureWriter = {
        $and: [
            becomesReviewEligible,
            noPreviousAttribution,
            { $ne: [{ $literal: completionCandidate?.writerId || null }, null] },
            { $gte: [{ $literal: completionCandidate?.assignmentVersion ?? -1 }, 0] },
        ],
    };
    const candidateWriterId = { $literal: completionCandidate?.writerId || null };
    const candidateVersion = { $literal: completionCandidate?.assignmentVersion ?? -1 };
    const completionTimestamp = {
        $dateToString: { date: '$$NOW', format: '%Y-%m-%dT%H:%M:%S.%LZ' },
    };
    const completedAt = {
        $cond: [
            { $eq: [resultingStatus, { $literal: 'Completed' }] },
            {
                $cond: [
                    { $eq: ['$orderStatus', 'Completed'] },
                    { $ifNull: ['$completedAt', completionTimestamp] },
                    completionTimestamp,
                ],
            },
            '$$REMOVE',
        ],
    };
    const eligibilityFilter: Record<string, unknown> = { orderId };
    if (completionCandidate) {
        const { writerId, assignmentVersion } = completionCandidate;
        const acceptedAttempt = {
            assignmentHistory: { $elemMatch: { writerId, assignmentVersion, status: 'accepted' } },
        };
        const acceptedReassignedAttempt = {
            assignmentHistory: { $elemMatch: {
                writerId,
                assignmentVersion,
                status: 'reassigned',
                respondedAt: { $exists: true, $ne: '' },
            } },
        };
        const legacyCurrentAssignment = assignmentVersion === 0
            ? {
                assignedWriterId: writerId,
                assignmentStatus: { $in: ['accepted', null] },
                assignmentVersion: { $in: [0, null] },
                $expr: { $eq: [{ $size: { $ifNull: ['$assignmentHistory', []] } }, 0] },
            }
            : null;
        eligibilityFilter.$or = [
            acceptedAttempt,
            acceptedReassignedAttempt,
            ...(legacyCurrentAssignment ? [legacyCurrentAssignment] : []),
        ];
    }

    const updateFilter = requiredFilter
        ? { $and: [eligibilityFilter, requiredFilter] }
        : eligibilityFilter;
    const writerSubmissions = submissionApproval
        ? {
            $map: {
                input: { $ifNull: ['$writerSubmissions', []] },
                as: 'submission',
                in: {
                    $cond: [
                        { $and: [
                            { $eq: ['$$submission.submissionId', { $literal: submissionApproval.submissionId }] },
                            { $eq: ['$$submission.writerId', { $literal: submissionApproval.writerId }] },
                            { $eq: ['$$submission.assignmentVersion', { $literal: submissionApproval.assignmentVersion }] },
                            { $eq: ['$$submission.reviewStatus', 'pending_review'] },
                        ] },
                        { $mergeObjects: ['$$submission', {
                            reviewStatus: 'approved',
                            reviewedAt: completionTimestamp,
                            reviewedByAdminId: { $literal: submissionApproval.reviewedByAdminId },
                        }] },
                        '$$submission',
                    ],
                },
            },
        }
        : '$writerSubmissions';
    const orderPipeline = [{
        $set: {
            ...requestedFields,
            writerSubmissions,
            completedAt,
            completedByWriterId: { $cond: [captureWriter, candidateWriterId, { $ifNull: ['$completedByWriterId', '$$REMOVE'] }] },
            completedAssignmentVersion: { $cond: [captureWriter, candidateVersion, { $ifNull: ['$completedAssignmentVersion', '$$REMOVE'] }] },
            writerCompletedAt: { $cond: [captureWriter, completionTimestamp, { $ifNull: ['$writerCompletedAt', '$$REMOVE'] }] },
            assignmentHistory: {
                $cond: [
                    captureWriter,
                    {
                        $map: {
                            input: { $ifNull: ['$assignmentHistory', []] },
                            as: 'attempt',
                            in: {
                                $cond: [
                                    { $and: [
                                        { $eq: ['$$attempt.writerId', candidateWriterId] },
                                        { $eq: ['$$attempt.assignmentVersion', candidateVersion] },
                                        { $in: ['$$attempt.status', ['accepted', 'reassigned']] },
                                        { $or: [
                                            { $eq: ['$$attempt.status', 'accepted'] },
                                            { $ne: [{ $ifNull: ['$$attempt.respondedAt', null] }, null] },
                                        ] },
                                    ] },
                                    { $mergeObjects: ['$$attempt', { completedAt: completionTimestamp }] },
                                    '$$attempt',
                                ],
                            },
                        },
                    },
                    '$assignmentHistory',
                ],
            },
        },
    }];

    const dbSession = await mongoose.startSession();
    let matched = false;
    try {
        await dbSession.withTransaction(async () => {
            matched = false;
            const current = await OrderModel.findOne({ orderId }).select(
                'orderStatus uploadedFiles deliveryFile writerSubmissions.fileId'
            ).session(dbSession).lean();
            if (!current) return;
            if (replacedDeliveryFileId && current.deliveryFile !== replacedDeliveryFileId) return;
            if (
                updates.orderStatus !== undefined &&
                !canTransitionOrderStatus(current.orderStatus as Order['orderStatus'], updates.orderStatus)
            ) return;
            if (updates.deliveryFile !== undefined && current.orderStatus === 'Completed') return;

            // Serialize status/reopen changes against retention's final reference
            // check by touching the same GridFS file documents in this transaction.
            if (updates.orderStatus !== undefined) {
                const db = mongoose.connection.db;
                if (!db) throw new Error('Database not connected');
                const fileIds = [...new Set([
                    ...(current.uploadedFiles || []),
                    ...(current.writerSubmissions || []).map((submission) => submission.fileId),
                    ...(current.deliveryFile ? [current.deliveryFile] : []),
                    ...(typeof updates.deliveryFile === 'string' ? [updates.deliveryFile] : []),
                ].filter((fileId) => typeof fileId === 'string' && mongoose.isValidObjectId(fileId)))];
                const files = db.collection('uploads.files');
                for (const fileId of fileIds) {
                    await files.updateOne(
                        { _id: new mongoose.Types.ObjectId(fileId) },
                        { $set: { 'metadata.lastOrderStatusChangeAt': new Date() } },
                        { session: dbSession }
                    );
                }
            }

            const statusGuard = updates.orderStatus !== undefined
                ? { orderStatus: current.orderStatus }
                : {};
            const atomicFilter = Object.keys(statusGuard).length
                ? { $and: [updateFilter, statusGuard] }
                : updateFilter;
            const result = await OrderModel.updateOne(atomicFilter, orderPipeline, {
                updatePipeline: true,
                session: dbSession,
            }).exec();
            matched = result.matchedCount > 0;
            if (matched && replacedDeliveryFileId && updates.deliveryFile !== replacedDeliveryFileId) {
                await scheduleReplacedDeliveryFileCleanup(replacedDeliveryFileId, dbSession);
            }
        });
    } finally {
        await dbSession.endSession();
    }

    if (!matched) return null;
    return getOrderById(orderId);
}
