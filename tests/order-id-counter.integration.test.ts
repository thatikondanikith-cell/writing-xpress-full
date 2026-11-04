import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Order } from '@/lib/types';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mongoTestDataRoot = resolve(projectRoot, '.mongodb-test-data');
const mongoTestRunToken = process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN &&
    /^[0-9a-f-]{36}$/i.test(process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN)
    ? process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN
    : randomUUID();
process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN = mongoTestRunToken;
const mongoTestRunDirectory = resolve(mongoTestDataRoot, `run-${process.pid}-${mongoTestRunToken}`);
const mongoTestDbPath = resolve(mongoTestRunDirectory, 'order-id-counter');
const mongoTestDatabaseName = `writing_xpress_counter_test_${randomUUID().replaceAll('-', '')}`;

let replSet: MongoMemoryReplSet | undefined;
let mongoose: typeof import('mongoose').default;
let OrderModel: typeof import('@/lib/models/Order').default;
let DailyOrderCounter: typeof import('@/lib/models/DailyOrderCounter').default;
let CustomerUploadBatch: typeof import('@/lib/models/CustomerUploadBatch').default;
let createOrder: typeof import('@/lib/db').createOrder;
const uploadTokens = new Map<string, string>();
let mongoTestDbPathCreated = false;

async function createMongoTestDbPath() {
    await mkdir(mongoTestDataRoot, { recursive: true });
    await mkdir(mongoTestRunDirectory, { recursive: true });
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    assert(relativeDbPath === `run-${process.pid}-${mongoTestRunToken}${sep}order-id-counter`, 'order counter MongoDB path must be this process suite directory');
    await mkdir(mongoTestDbPath);
    mongoTestDbPathCreated = true;
}

async function removeMongoTestDbPath() {
    if (!mongoTestDbPathCreated) return;
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    assert(relativeDbPath === `run-${process.pid}-${mongoTestRunToken}${sep}order-id-counter`, 'refusing to remove an unexpected order counter MongoDB path');
    await rm(mongoTestDbPath, { recursive: true });
    mongoTestDbPathCreated = false;
}

function todayKey() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function makeOrderData(fileId: string): Omit<Order, 'orderId' | 'createdDate' | 'orderStatus'> {
    return {
        userName: 'Test Customer',
        primaryPhone: '555-0100',
        email: 'customer@example.test',
        collegeName: 'Test College',
        yearOfStudying: '3',
        branch: 'Computer Science',
        uploadedFiles: [fileId],
        instructions: 'Counter integration test',
    };
}

async function addReferenceFile() {
    const fileId = new mongoose.Types.ObjectId();
    const db = mongoose.connection.db;
    assert(db, 'MongoDB connection should be open');
    const batchId = randomUUID();
    const uploadToken = randomBytes(32).toString('base64url');
    const { hashCustomerUploadToken, CUSTOMER_UPLOAD_TOKEN_TTL_MS, CUSTOMER_UPLOAD_BATCH_PURGE_MS } = await import('@/lib/customer-upload');
    const now = new Date();
    await db.collection('uploads.files').insertOne({
        _id: fileId,
        filename: 'test.pdf',
        metadata: { purpose: 'customer-reference', customerUploadBatchId: batchId },
    });
    await CustomerUploadBatch.create({
        batchId,
        tokenHash: hashCustomerUploadToken(uploadToken),
        fileIds: [fileId.toString()],
        email: 'customer@example.test',
        expiresAt: new Date(now.getTime() + CUSTOMER_UPLOAD_TOKEN_TTL_MS),
        purgeAt: new Date(now.getTime() + CUSTOMER_UPLOAD_BATCH_PURGE_MS),
        createdAt: now,
    });
    uploadTokens.set(fileId.toString(), uploadToken);
    return fileId.toString();
}

function createOrderForData(data: Omit<Order, 'orderId' | 'createdDate' | 'orderStatus'>) {
    const token = uploadTokens.get(data.uploadedFiles[0]);
    assert(token, 'test reference file should have an upload token');
    return createOrder(data, token, data.email);
}

async function insertExistingOrder(orderId: string) {
    await OrderModel.create({
        ...makeOrderData(new mongoose.Types.ObjectId().toString()),
        orderId,
        createdDate: new Date().toISOString(),
        orderStatus: 'Submitted',
    });
}

beforeAll(async () => {
    await createMongoTestDbPath();
    replSet = await MongoMemoryReplSet.create({
        instanceOpts: [{ dbPath: mongoTestDbPath }],
        replSet: {
            count: 1,
            ip: '127.0.0.1',
            dbName: mongoTestDatabaseName,
            storageEngine: 'wiredTiger',
        },
    });
    const uri = replSet.getUri(mongoTestDatabaseName);
    const parsed = new URL(uri);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'test MongoDB must bind to loopback');
    assert(parsed.pathname.slice(1).startsWith('writing_xpress_counter_test_'), 'test MongoDB must use an isolated test database');
    process.env.MONGODB_URI = uri;

    const [mongooseModule, connectionModule, orderModule, counterModule, batchModule, dbModule] = await Promise.all([
        import('mongoose'),
        import('@/lib/mongoose'),
        import('@/lib/models/Order'),
        import('@/lib/models/DailyOrderCounter'),
        import('@/lib/models/CustomerUploadBatch'),
        import('@/lib/db'),
    ]);
    mongoose = mongooseModule.default;
    OrderModel = orderModule.default;
    DailyOrderCounter = counterModule.default;
    CustomerUploadBatch = batchModule.default;
    createOrder = dbModule.createOrder;
    await connectionModule.connectDB();
    await Promise.all([OrderModel.init(), DailyOrderCounter.init(), CustomerUploadBatch.init()]);
}, 120_000);

beforeEach(async () => {
    await Promise.all([OrderModel.deleteMany({}), DailyOrderCounter.deleteMany({}), CustomerUploadBatch.deleteMany({})]);
    uploadTokens.clear();
    const db = mongoose.connection.db;
    assert(db, 'MongoDB connection should be open');
    await db.collection('uploads.files').deleteMany({});
    vi.restoreAllMocks();
});

afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) {
        const stopped = await replSet.stop();
        if (!stopped) throw new Error('Could not stop order counter MongoMemoryReplSet; leaving its dbPath intact');
    }
    await removeMongoTestDbPath();
    delete process.env.MONGODB_URI;
});

describe('transactional daily order ID counter', () => {
    it('starts the first order of a day at 0001 and continues the counter', async () => {
        const first = (await createOrderForData(makeOrderData(await addReferenceFile()))).order;
        const second = (await createOrderForData(makeOrderData(await addReferenceFile()))).order;
        expect(first.orderId).toBe(`WX-${todayKey()}-0001`);
        expect(second.orderId).toBe(`WX-${todayKey()}-0002`);
    });

    it('continues after the highest existing daily order when no counter exists', async () => {
        await insertExistingOrder(`WX-${todayKey()}-0042`);
        const created = (await createOrderForData(makeOrderData(await addReferenceFile()))).order;
        expect(created.orderId).toBe(`WX-${todayKey()}-0043`);
        const counter = await DailyOrderCounter.findById(todayKey()).lean();
        expect(counter?.sequence).toBe(43);
    });

    it('seeds a missing counter from a legacy suffix above 9999', async () => {
        const existingOrderId = `WX-${todayKey()}-10000`;
        await insertExistingOrder(existingOrderId);
        expect(await DailyOrderCounter.findById(todayKey()).lean()).toBeNull();

        const created = (await createOrderForData(makeOrderData(await addReferenceFile()))).order;
        expect(created.orderId).toBe(`WX-${todayKey()}-10001`);
        expect(await OrderModel.exists({ orderId: existingOrderId })).not.toBeNull();
    });

    it('assigns distinct sequential IDs to concurrent first-time order creation', async () => {
        const fileIds = await Promise.all(Array.from({ length: 8 }, () => addReferenceFile()));
        const results = await Promise.all(fileIds.map((fileId) => createOrderForData(makeOrderData(fileId))));
        const created = results.map((result) => result.order);
        const suffixes = created.map((order) => Number(order.orderId.split('-')[2])).sort((a, b) => a - b);
        expect(suffixes).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(new Set(created.map((order) => order.orderId)).size).toBe(8);
    });

    it('retries deterministic concurrent first-time counter initialization without duplicate-key failures', async () => {
        const requestCount = 6;
        const fileIds = await Promise.all(Array.from({ length: requestCount }, () => addReferenceFile()));
        expect(await DailyOrderCounter.findById(todayKey()).lean()).toBeNull();

        const originalCreate = DailyOrderCounter.create.bind(DailyOrderCounter);
        let initializersAtBarrier = 0;
        let releaseInitializers!: () => void;
        const allInitializersReady = new Promise<void>((resolve) => { releaseInitializers = resolve; });
        const createSpy = vi.spyOn(DailyOrderCounter, 'create');
        createSpy.mockImplementation((async (...args: Parameters<typeof DailyOrderCounter.create>) => {
            if (initializersAtBarrier < requestCount) {
                initializersAtBarrier += 1;
                if (initializersAtBarrier === requestCount) releaseInitializers();
                await allInitializersReady;
            }
            return originalCreate(...args);
        }) as typeof DailyOrderCounter.create);

        try {
            const results = await Promise.all(fileIds.map((fileId) => createOrderForData(makeOrderData(fileId))));
            const created = results.map((result) => result.order);
            const suffixes = created.map((order) => Number(order.orderId.split('-')[2])).sort((a, b) => a - b);
            expect(initializersAtBarrier).toBe(requestCount);
            expect(suffixes).toEqual([1, 2, 3, 4, 5, 6]);
            expect(new Set(created.map((order) => order.orderId)).size).toBe(requestCount);
            expect(await OrderModel.countDocuments({ orderId: { $regex: `^WX-${todayKey()}-` } })).toBe(requestCount);
        } finally {
            createSpy.mockRestore();
        }
    });

    it('rolls back the counter increment when order insertion fails', async () => {
        const fileId = await addReferenceFile();
        const createSpy = vi.spyOn(OrderModel, 'create').mockRejectedValueOnce(new Error('injected order insert failure'));
        await expect(createOrderForData(makeOrderData(fileId))).rejects.toThrow('injected order insert failure');
        expect(await DailyOrderCounter.findById(todayKey()).lean()).toBeNull();

        createSpy.mockRestore();
        const created = (await createOrderForData(makeOrderData(fileId))).order;
        expect(created.orderId).toBe(`WX-${todayKey()}-0001`);
    });

    it('retries a transient transaction failure without consuming an ID', async () => {
        const fileId = await addReferenceFile();
        const transient = Object.assign(new Error('injected transient transaction failure'), {
            hasErrorLabel: (label: string) => label === 'TransientTransactionError',
        });
        const originalCreate = OrderModel.create.bind(OrderModel);
        const createSpy = vi.spyOn(OrderModel, 'create')
            .mockRejectedValueOnce(transient)
            .mockImplementation(originalCreate);

        const created = (await createOrderForData(makeOrderData(fileId))).order;
        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(created.orderId).toBe(`WX-${todayKey()}-0001`);
        expect((await DailyOrderCounter.findById(todayKey()).lean())?.sequence).toBe(1);
    });

    it('preserves the existing minimum four-digit formatting above 9999', async () => {
        await DailyOrderCounter.create({ _id: todayKey(), sequence: 9999 });
        const created = (await createOrderForData(makeOrderData(await addReferenceFile()))).order;
        expect(created.orderId).toBe(`WX-${todayKey()}-10000`);
    });

    it('enforces the unique orderId index in the isolated test database', async () => {
        const indexes = await OrderModel.collection.indexes();
        expect(indexes).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: { orderId: 1 }, unique: true }),
        ]));

        const orderId = `WX-${todayKey()}-0099`;
        await insertExistingOrder(orderId);
        await expect(OrderModel.create({
            ...makeOrderData(new mongoose.Types.ObjectId().toString()),
            orderId,
            createdDate: new Date().toISOString(),
            orderStatus: 'Submitted',
        })).rejects.toMatchObject({ code: 11000 });
        expect(await OrderModel.countDocuments({ orderId })).toBe(1);
    });
});
