import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('@/lib/email', () => ({
    getAdminNotificationEmail: vi.fn(() => 'admin@example.test'),
    sendWorkflowEmail: vi.fn(async () => 'accepted'),
}));

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mongoTestDataRoot = resolve(projectRoot, '.mongodb-test-data');
const mongoTestRunToken = process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN &&
    /^[0-9a-f-]{36}$/i.test(process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN)
    ? process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN
    : randomUUID();
process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN = mongoTestRunToken;
const mongoTestRunDirectory = resolve(mongoTestDataRoot, `run-${process.pid}-${mongoTestRunToken}`);
const mongoTestDbPath = resolve(mongoTestRunDirectory, 'customer-upload-ownership');
const mongoTestDatabaseName = `wx_upload_owner_${randomUUID().replaceAll('-', '')}`;

let replSet: MongoMemoryReplSet | undefined;
let mongoose: typeof import('mongoose').default;
let OrderModel: typeof import('@/lib/models/Order').default;
let DailyOrderCounter: typeof import('@/lib/models/DailyOrderCounter').default;
let CustomerUploadBatch: typeof import('@/lib/models/CustomerUploadBatch').default;
let FileRetentionTask: typeof import('@/lib/models/FileRetentionTask').default;
let OtpIpRateLimit: typeof import('@/lib/models/OtpIpRateLimit').default;
let UserModel: typeof import('@/lib/models/User').default;
let uploadRoute: typeof import('@/app/api/upload/route').POST;
let createOrderRoute: typeof import('@/app/api/orders/route').POST;
let customerOrdersRoute: typeof import('@/app/api/user/orders/route').GET;
let customerOrderDetailRoute: typeof import('@/app/api/user/orders/[id]/route').GET;
let customerReviewRoute: typeof import('@/app/api/user/orders/[id]/review/route').POST;
let publicReviewsRoute: typeof import('@/app/api/public/reviews/route').GET;
let getFileRoute: typeof import('@/app/api/files/[id]/route').GET;
let writerSubmissionRoute: typeof import('@/app/api/writer/orders/[id]/submission/route').POST;
let adminOrderRoute: typeof import('@/app/api/orders/[id]/route').PUT;
let adminSubmissionDecisionRoute: typeof import('@/app/api/admin/submissions/[id]/route').POST;
let adminSubmissionQueueRoute: typeof import('@/app/api/admin/submissions/route').GET;
let uploadFileToGridFS: typeof import('@/lib/gridfs').uploadFileToGridFS;
let orderDbModule: typeof import('@/lib/db');
let createToken: typeof import('@/lib/auth').createToken;
let cleanupExpiredFiles: typeof import('@/lib/file-retention').cleanupExpiredFiles;
let cleanupCronRoute: typeof import('@/app/api/cron/cleanup-files/route').GET;
let mongoTestDbPathCreated = false;
let ipSequence = 1;
const defaultCustomerId = '507f1f77bcf86cd799439011';
const defaultCustomerEmail = 'customer@example.test';

async function createMongoTestDbPath() {
    await mkdir(mongoTestDataRoot, { recursive: true });
    await mkdir(mongoTestRunDirectory, { recursive: true });
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    assert(relativeDbPath === `run-${process.pid}-${mongoTestRunToken}${sep}customer-upload-ownership`, 'upload ownership MongoDB path must be this process suite directory');
    await mkdir(mongoTestDbPath);
    mongoTestDbPathCreated = true;
}

async function removeMongoTestDbPath() {
    if (!mongoTestDbPathCreated) return;
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    assert(relativeDbPath === `run-${process.pid}-${mongoTestRunToken}${sep}customer-upload-ownership`, 'refusing to remove an unexpected upload ownership MongoDB path');
    await rm(mongoTestDbPath, { recursive: true });
    mongoTestDbPathCreated = false;
}

function makeOrderPayload(upload: { files: string[]; uploadToken: string }, extra: Record<string, unknown> = {}) {
    return {
        userName: 'Ownership Test Customer',
        primaryPhone: '555-0100',
        email: 'Customer@Example.Test',
        collegeName: 'Test College',
        yearOfStudying: '3rd Year',
        branch: 'Computer Science',
        uploadedFiles: upload.files,
        uploadToken: upload.uploadToken,
        instructions: 'Please complete the test assignment.',
        priceAmount: 123,
        transactionId: 'isolated-test-transaction',
        ...extra,
    };
}

function makePdf(): Buffer {
    const header = Buffer.from('%PDF-1.4\n% test\n', 'ascii');
    const objects = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n',
        '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
    ];
    const chunks = [header];
    const offsets = [0];
    let offset = header.length;
    for (const object of objects) {
        offsets.push(offset);
        const bytes = Buffer.from(object, 'ascii');
        chunks.push(bytes);
        offset += bytes.length;
    }
    const xrefOffset = offset;
    let xref = 'xref\n0 5\n0000000000 65535 f \n';
    for (const value of offsets.slice(1)) xref += `${String(value).padStart(10, '0')} 00000 n \n`;
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'ascii'));
    return Buffer.concat(chunks);
}

async function uploadFiles(count = 1, email = 'Customer@Example.Test') {
    const form = new FormData();
    form.append('email', email);
    for (let index = 0; index < count; index += 1) {
        form.append('files', new File([new Uint8Array(makePdf())], `ref-${index}.pdf`, { type: 'application/pdf' }));
    }
    const response = await uploadRoute(new NextRequest('http://localhost/api/upload', {
        method: 'POST',
        headers: { 'x-vercel-forwarded-for': `192.0.2.${ipSequence++}` },
        body: form,
    }));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<{ success: boolean; files: string[]; uploadToken: string }>;
}

async function createRetentionOrder(input: {
    orderId: string;
    fileIds: string[];
    orderStatus?: 'Submitted' | 'In Progress' | 'Completed';
    completedAt?: string;
}) {
    return OrderModel.create({
        orderId: input.orderId,
        userName: 'Retention Test Customer',
        primaryPhone: '555-0199',
        email: 'retention@example.test',
        collegeName: 'Test College',
        yearOfStudying: '3rd Year',
        branch: 'Computer Science',
        uploadedFiles: input.fileIds,
        instructions: 'Retention integration fixture',
        orderStatus: input.orderStatus || 'Submitted',
        createdDate: new Date().toISOString(),
        ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    });
}

async function createInProgressOrderWithOldDelivery() {
    const customerUpload = await uploadFiles();
    const orderResponse = await submitOrder(makeOrderPayload(customerUpload));
    assert.equal(orderResponse.status, 201);
    const order = await orderResponse.json();
    await OrderModel.updateOne({ orderId: order.orderId }, { $set: { orderStatus: 'In Progress' } });
    const oldDeliveryFileId = await uploadFileToGridFS(
        makePdf(), 'delivery-previous.pdf', 'application/pdf', 'delivery',
        { fileValidationVersion: 1, validatedContentType: 'application/pdf' }
    );
    await OrderModel.updateOne({ orderId: order.orderId }, { $set: { deliveryFile: oldDeliveryFileId } });
    return { orderId: order.orderId as string, oldDeliveryFileId };
}

function makeAdminDeliveryRequest(orderId: string) {
    const form = new FormData();
    form.append('orderStatus', 'Completed');
    form.append('deliveryFile', new File([new Uint8Array(makePdf())], 'replacement.pdf', { type: 'application/pdf' }));
    const adminToken = createToken({ sub: 'test-admin', role: 'admin' });
    return adminOrderRoute(new NextRequest(`http://localhost/api/orders/${orderId}`, {
        method: 'PUT', headers: { cookie: `session=${adminToken}` }, body: form,
    }), { params: Promise.resolve({ id: orderId }) });
}

async function createAcceptedWriterAssignment() {
    const customerUpload = await uploadFiles();
    const orderResponse = await submitOrder(makeOrderPayload(customerUpload));
    assert.equal(orderResponse.status, 201);
    const order = await orderResponse.json();
    const writerId = new mongoose.Types.ObjectId();
    await UserModel.create({
        _id: writerId, name: 'Retention Test Writer', email: 'retention-writer@example.test', passwordHash: 'unused-test-hash',
        createdAt: new Date().toISOString(), role: 'writer', applicationStatus: 'approved', isAvailable: true,
    });
    const assignedAt = new Date().toISOString();
    await OrderModel.updateOne({ orderId: order.orderId }, { $set: {
        assignedWriterId: writerId.toString(), assignmentStatus: 'accepted', assignmentVersion: 1,
        writerWorkflowStatus: 'assigned',
        assignmentHistory: [{ writerId: writerId.toString(), assignedAt, assignedByAdminId: 'test-admin', assignmentVersion: 1, status: 'accepted', respondedAt: assignedAt }],
    } });
    return {
        orderId: order.orderId as string,
        writerId: writerId.toString(),
        writerToken: createToken({ sub: writerId.toString(), role: 'writer', email: 'retention-writer@example.test' }),
    };
}

function makeWriterSubmissionRequest(orderId: string, writerToken: string) {
    const form = new FormData();
    form.append('assignmentVersion', '1');
    form.append('submissionFile', new File([new Uint8Array(makePdf())], 'writer-work.pdf', { type: 'application/pdf' }));
    return writerSubmissionRoute(new NextRequest(`http://localhost/api/writer/orders/${orderId}/submission`, {
        method: 'POST', headers: { cookie: `session=${writerToken}` }, body: form,
    }), { params: Promise.resolve({ id: orderId }) });
}

function makeAdminReviewRequest(orderId: string, body: unknown, token = createToken({ sub: 'test-admin', role: 'admin' })) {
    return adminSubmissionDecisionRoute(new NextRequest(`http://localhost/api/admin/submissions/${orderId}`, {
        method: 'POST',
        headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: orderId }) });
}

function makeCustomerReviewRequest(orderId: string, body: unknown, token: string | null = customerSession()) {
    return customerReviewRoute(new NextRequest(`http://localhost/api/user/orders/${orderId}/review`, {
        method: 'POST', headers: { ...(token ? { cookie: `session=${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: orderId }) });
}

function makeAdminReviewQueueRequest(token = createToken({ sub: 'test-admin', role: 'admin' })) {
    return adminSubmissionQueueRoute(new NextRequest('http://localhost/api/admin/submissions', {
        headers: { cookie: `session=${token}` },
    }));
}

async function createPendingWriterSubmission() {
    const assignment = await createAcceptedWriterAssignment();
    await OrderModel.updateOne({ orderId: assignment.orderId }, { $set: { orderStatus: 'In Progress' } });
    const response = await makeWriterSubmissionRequest(assignment.orderId, assignment.writerToken);
    assert.equal(response.status, 200);
    const result = await response.json();
    return {
        ...assignment,
        submissionId: result.submissionId as string,
        assignmentVersion: 1,
    };
}

function mockWriterOrderUpdateResult(result: () => Promise<unknown>) {
    let query: { select: () => typeof query; lean: () => Promise<unknown> };
    query = { select: () => query, lean: result };
    return vi.spyOn(OrderModel, 'findOneAndUpdate').mockReturnValueOnce(query as never);
}

function customerSession(email = defaultCustomerEmail, sub = defaultCustomerId) {
    return createToken({ sub, role: 'user', email });
}

function submitOrder(body: Record<string, unknown>, token: string | null = customerSession()) {
    return createOrderRoute(new NextRequest('http://localhost/api/orders', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? { cookie: `session=${token}` } : {}),
        },
        body: JSON.stringify(body),
    }));
}

function getCustomerHistory(token: string, query = '?page=1&limit=5') {
    return customerOrdersRoute(new NextRequest(`http://localhost/api/user/orders${query}`, {
        headers: { cookie: `session=${token}` },
    }));
}

beforeAll(async () => {
    if (process.env.WRITING_XPRESS_ISOLATED_TEST !== '1') {
        throw new Error('Use the isolated Vitest runner; direct customer upload ownership integration test execution is disabled.');
    }
    Reflect.set(process.env, 'NODE_ENV', 'test');
    process.env.JWT_SECRET = 'customer-upload-ownership-test-secret-at-least-32-bytes';
    process.env.OTP_HASH_SECRET = 'customer-upload-ownership-rate-limit-secret';

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
    assert(parsed.pathname.slice(1) === mongoTestDatabaseName, 'test MongoDB must use an isolated test database');
    process.env.MONGODB_URI = uri;

    const [mongooseModule, connectionModule, orderModule, counterModule, batchModule, retentionTaskModule, limiterModelModule, userModule, uploadModule, orderRouteModule, customerOrdersModule, customerOrderDetailModule, customerReviewModule, publicReviewsModule, fileRouteModule, writerSubmissionModule, adminOrderModule, adminSubmissionModule, adminSubmissionQueueModule, authModule, retentionModule, cleanupCronModule, gridfsModule, dbModule] = await Promise.all([
        import('mongoose'),
        import('@/lib/mongoose'),
        import('@/lib/models/Order'),
        import('@/lib/models/DailyOrderCounter'),
        import('@/lib/models/CustomerUploadBatch'),
        import('@/lib/models/FileRetentionTask'),
        import('@/lib/models/OtpIpRateLimit'),
        import('@/lib/models/User'),
        import('@/app/api/upload/route'),
        import('@/app/api/orders/route'),
        import('@/app/api/user/orders/route'),
        import('@/app/api/user/orders/[id]/route'),
        import('@/app/api/user/orders/[id]/review/route'),
        import('@/app/api/public/reviews/route'),
        import('@/app/api/files/[id]/route'),
        import('@/app/api/writer/orders/[id]/submission/route'),
        import('@/app/api/orders/[id]/route'),
        import('@/app/api/admin/submissions/[id]/route'),
        import('@/app/api/admin/submissions/route'),
        import('@/lib/auth'),
        import('@/lib/file-retention'),
        import('@/app/api/cron/cleanup-files/route'),
        import('@/lib/gridfs'),
        import('@/lib/db'),
    ]);
    mongoose = mongooseModule.default;
    OrderModel = orderModule.default;
    DailyOrderCounter = counterModule.default;
    CustomerUploadBatch = batchModule.default;
    FileRetentionTask = retentionTaskModule.default;
    OtpIpRateLimit = limiterModelModule.default;
    UserModel = userModule.default;
    uploadRoute = uploadModule.POST;
    createOrderRoute = orderRouteModule.POST;
    customerOrdersRoute = customerOrdersModule.GET;
    customerOrderDetailRoute = customerOrderDetailModule.GET;
    customerReviewRoute = customerReviewModule.POST;
    publicReviewsRoute = publicReviewsModule.GET;
    getFileRoute = fileRouteModule.GET;
    writerSubmissionRoute = writerSubmissionModule.POST;
    adminOrderRoute = adminOrderModule.PUT;
    adminSubmissionDecisionRoute = adminSubmissionModule.POST;
    adminSubmissionQueueRoute = adminSubmissionQueueModule.GET;
    createToken = authModule.createToken;
    cleanupExpiredFiles = retentionModule.cleanupExpiredFiles;
    cleanupCronRoute = cleanupCronModule.GET;
    uploadFileToGridFS = gridfsModule.uploadFileToGridFS;
    orderDbModule = dbModule;
    await connectionModule.connectDB();
    await Promise.all([
        OrderModel.init(), DailyOrderCounter.init(), CustomerUploadBatch.init(), FileRetentionTask.init(),
        OtpIpRateLimit.init(), UserModel.init(),
    ]);
}, 120_000);

beforeEach(async () => {
    await Promise.all([
        OrderModel.deleteMany({}), DailyOrderCounter.deleteMany({}), CustomerUploadBatch.deleteMany({}),
        OtpIpRateLimit.deleteMany({}), UserModel.deleteMany({}), FileRetentionTask.deleteMany({}),
    ]);
    const db = mongoose.connection.db;
    assert(db, 'MongoDB connection should be open');
    await Promise.all([
        db.collection('uploads.files').deleteMany({}),
        db.collection('uploads.chunks').deleteMany({}),
    ]);
    ipSequence = 1;
    vi.clearAllMocks();
    vi.mocked((await import('@/lib/email')).getAdminNotificationEmail).mockReturnValue('admin@example.test');
});

afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) {
        const stopped = await replSet.stop();
        if (!stopped) throw new Error('Could not stop customer upload ownership MongoMemoryReplSet; leaving its dbPath intact');
    }
    await removeMongoTestDbPath();
    delete process.env.MONGODB_URI;
    delete process.env.JWT_SECRET;
    delete process.env.OTP_HASH_SECRET;
});

describe('customer upload ownership binding', () => {
    it('creates order and claims exactly the files bound to a normalized-email upload batch', async () => {
        const upload = await uploadFiles(2);
        const batch = await CustomerUploadBatch.findOne({ fileIds: upload.files }).lean();
        expect(batch?.email).toBe('customer@example.test');
        expect(batch?.tokenHash).not.toBe(upload.uploadToken);
        expect(batch?.fileIds).toEqual(upload.files);
        const response = await submitOrder(makeOrderPayload(upload));
        expect(response.status).toBe(201);
        const created = await response.json();
        expect(created.ownerEmail).toBe(defaultCustomerEmail);
        expect(created.email).toBe(defaultCustomerEmail);
        const stored = await OrderModel.findOne({ orderId: created.orderId }).lean();
        expect(stored?.ownerEmail).toBe(defaultCustomerEmail);
        const claimed = await CustomerUploadBatch.findOne({ batchId: batch?.batchId }).lean();
        expect(claimed?.claimedOrderId).toBe(created.orderId);
        const files = await mongoose.connection.db!.collection('uploads.files').find({ _id: { $in: upload.files.map((id) => new mongoose.Types.ObjectId(id)) } }).toArray();
        expect(files.every((file) => file.metadata?.claimedOrderId === created.orderId)).toBe(true);
    });

    it('keeps authenticated ownership separate from contact email and authorizes history by account', async () => {
        const { sendWorkflowEmail } = await import('@/lib/email');
        const contactEmail = 'different-contact@example.test';
        const upload = await uploadFiles(1, contactEmail);
        const body = makeOrderPayload(upload, { email: contactEmail, ownerEmail: 'spoofed-owner@example.test' });
        const response = await submitOrder(body);
        expect(response.status).toBe(201);
        const created = await response.json();

        expect(created.ownerEmail).toBe(defaultCustomerEmail);
        expect(created.email).toBe(contactEmail);
        expect(await OrderModel.findOne({ orderId: created.orderId }).lean()).toMatchObject({
            ownerEmail: defaultCustomerEmail,
            email: contactEmail,
        });
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({
            event: 'order_submitted',
            to: contactEmail,
        }));

        const ownerToken = customerSession();
        const history = await getCustomerHistory(ownerToken, `?page=1&limit=5&search=${created.orderId}&status=Submitted&month=All`);
        expect(history.status).toBe(200);
        expect((await history.json()).orders.map((order: { orderId: string }) => order.orderId)).toContain(created.orderId);

        const otherToken = customerSession('another-customer@example.test', '507f1f77bcf86cd799439012');
        const otherHistory = await getCustomerHistory(otherToken);
        expect(otherHistory.status).toBe(200);
        expect((await otherHistory.json()).orders).toEqual([]);

        const otherDetail = await customerOrderDetailRoute(
            new NextRequest(`http://localhost/api/user/orders/${created.orderId}`, {
                headers: { cookie: `session=${otherToken}` },
            }),
            { params: Promise.resolve({ id: created.orderId }) },
        );
        expect(otherDetail.status).toBe(404);

        const ownerDetail = await customerOrderDetailRoute(
            new NextRequest(`http://localhost/api/user/orders/${created.orderId}`, {
                headers: { cookie: `session=${ownerToken}` },
            }),
            { params: Promise.resolve({ id: created.orderId }) },
        );
        expect(ownerDetail.status).toBe(200);
        expect((await ownerDetail.json()).order.email).toBe(contactEmail);

        const replayByOtherCustomer = await submitOrder(body, otherToken);
        expect(replayByOtherCustomer.status).toBe(409);
    });

    it('sends a deduplicated admin new-order notification after commit with order details and the admin route', async () => {
        const { getAdminNotificationEmail, sendWorkflowEmail } = await import('@/lib/email');
        vi.mocked(getAdminNotificationEmail).mockReturnValue('writingxpress.online@gmail.com');
        const upload = await uploadFiles(1);
        const body = makeOrderPayload(upload);
        const response = await submitOrder(body);
        const created = await response.json();

        expect(response.status).toBe(201);
        expect(await OrderModel.exists({ orderId: created.orderId })).not.toBeNull();
        expect(sendWorkflowEmail).toHaveBeenCalledTimes(2);
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({
            event: 'order_submitted',
            to: defaultCustomerEmail,
            idempotencyKey: `order-submitted/${created.orderId}`,
        }));
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({
            event: 'admin_new_order',
            to: 'writingxpress.online@gmail.com',
            subject: 'New Order Received – WRITING-XPRESS',
            heading: 'A New Order Has Been Placed!',
            text: expect.stringContaining(`Order ID: ${created.orderId}`),
            action: { label: 'View Order', path: `/admin/order/${encodeURIComponent(created.orderId)}` },
            idempotencyKey: `admin-new-order/${created.orderId}`,
        }));
        const adminMail = vi.mocked(sendWorkflowEmail).mock.calls.map(([email]) => email).find((email) => email.event === 'admin_new_order');
        expect(adminMail?.text).toContain('Customer name: Ownership Test Customer');
        expect(adminMail?.text).toContain('Customer contact email: customer@example.test');
        expect(adminMail?.text).toContain('Assignment type: Computer Science');
        expect(adminMail?.text).toContain('Order amount: ₹123.00');
        expect(adminMail?.text).toContain('Current order status: Submitted');

        await submitOrder(body);
        expect(sendWorkflowEmail).toHaveBeenCalledTimes(2);
    });

    it('continues order creation without an admin email configuration', async () => {
        const { getAdminNotificationEmail, sendWorkflowEmail } = await import('@/lib/email');
        vi.mocked(getAdminNotificationEmail).mockReturnValue(undefined);
        const upload = await uploadFiles(1);
        const response = await submitOrder(makeOrderPayload(upload));
        expect(response.status).toBe(201);
        expect(sendWorkflowEmail).toHaveBeenCalledTimes(1);
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({ event: 'order_submitted' }));
    });

    it('does not invalidate a committed order when admin email delivery fails', async () => {
        const { sendWorkflowEmail } = await import('@/lib/email');
        vi.mocked(sendWorkflowEmail).mockResolvedValue('failed');
        const upload = await uploadFiles(1);
        const response = await submitOrder(makeOrderPayload(upload));
        const created = await response.json();
        expect(response.status).toBe(201);
        expect(await OrderModel.exists({ orderId: created.orderId })).not.toBeNull();
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({ event: 'admin_new_order' }));
    });

    it('does not send order notifications when order creation fails', async () => {
        const { sendWorkflowEmail } = await import('@/lib/email');
        const upload = await uploadFiles(1);
        const createSpy = vi.spyOn(OrderModel, 'create').mockRejectedValueOnce(new Error('injected order insert failure'));
        expect((await submitOrder(makeOrderPayload(upload))).status).toBe(500);
        createSpy.mockRestore();
        expect(sendWorkflowEmail).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated order creation without claiming the upload batch', async () => {
        const upload = await uploadFiles();
        const response = await submitOrder(makeOrderPayload(upload), null);
        expect(response.status).toBe(401);
        expect(await OrderModel.countDocuments()).toBe(0);
        expect(await CustomerUploadBatch.countDocuments({ claimedOrderId: { $exists: true } })).toBe(0);
    });

    it('keeps legacy orders accessible through their existing email ownership', async () => {
        const legacyOrderId = `WX-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-9900`;
        await OrderModel.create({
            orderId: legacyOrderId,
            userName: 'Legacy Customer',
            primaryPhone: '555-0110',
            email: defaultCustomerEmail,
            collegeName: 'Test College',
            yearOfStudying: '3rd Year',
            branch: 'Computer Science',
            uploadedFiles: [],
            instructions: 'Legacy order fixture',
            orderStatus: 'Submitted',
            createdDate: new Date().toISOString(),
        });

        const history = await getCustomerHistory(customerSession());
        expect(history.status).toBe(200);
        expect((await history.json()).orders.map((order: { orderId: string }) => order.orderId)).toContain(legacyOrderId);
    });

    it('rejects missing and malformed upload tokens', async () => {
        const upload = await uploadFiles();
        const missing = makeOrderPayload(upload);
        delete (missing as Partial<typeof missing>).uploadToken;
        expect((await submitOrder(missing)).status).toBe(400);
        expect((await submitOrder(makeOrderPayload(upload, { uploadToken: 'invalid' }))).status).toBe(400);
        expect(await OrderModel.countDocuments()).toBe(0);
    });

    it('rejects an expired batch and a different normalized email', async () => {
        const expiredUpload = await uploadFiles();
        await CustomerUploadBatch.updateOne(
            { tokenHash: (await import('@/lib/customer-upload')).hashCustomerUploadToken(expiredUpload.uploadToken) },
            { $set: { expiresAt: new Date(Date.now() - 1000) } }
        );
        expect((await submitOrder(makeOrderPayload(expiredUpload))).status).toBe(400);

        const otherUpload = await uploadFiles();
        expect((await submitOrder(makeOrderPayload(otherUpload, { email: 'someone-else@example.test' }))).status).toBe(400);
    });

    it.each([
        ['omitted', (files: string[]) => files.slice(1)],
        ['altered', (files: string[]) => [new mongoose.Types.ObjectId().toString(), ...files.slice(1)]],
        ['additional', (files: string[]) => [...files, new mongoose.Types.ObjectId().toString()]],
    ])('rejects %s file IDs that differ from the batch', async (_label, change) => {
        const upload = await uploadFiles(2);
        const response = await submitOrder(makeOrderPayload(upload, { uploadedFiles: change(upload.files) }));
        expect(response.status).toBe(400);
        expect(await OrderModel.countDocuments()).toBe(0);
    });

    it.each([
        ['purpose', { 'metadata.purpose': 'delivery' }],
        ['batch ID', { 'metadata.customerUploadBatchId': 'wrong-batch' }],
    ])('rejects a file with incorrect %s metadata', async (_label, update) => {
        const upload = await uploadFiles();
        await mongoose.connection.db!.collection('uploads.files').updateOne(
            { _id: new mongoose.Types.ObjectId(upload.files[0]) }, { $set: update }
        );
        expect((await submitOrder(makeOrderPayload(upload))).status).toBe(400);
        expect(await CustomerUploadBatch.countDocuments({ claimedOrderId: { $exists: true } })).toBe(0);
    });

    it('returns the existing order on an identical retry without repeating email side effects', async () => {
        const { sendWorkflowEmail } = await import('@/lib/email');
        const upload = await uploadFiles();
        const body = makeOrderPayload(upload);
        const first = await submitOrder(body);
        const firstOrder = await first.json();
        const retry = await submitOrder(body);
        expect(first.status).toBe(201);
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual(firstOrder);
        expect(sendWorkflowEmail).toHaveBeenCalledTimes(2);
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({ event: 'order_submitted' }));
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({ event: 'admin_new_order' }));
        expect(await OrderModel.countDocuments()).toBe(1);
    });

    it('rejects changed data after a batch has been claimed', async () => {
        const upload = await uploadFiles();
        expect((await submitOrder(makeOrderPayload(upload))).status).toBe(201);
        expect((await submitOrder(makeOrderPayload(upload, { instructions: 'Different order payload' }))).status).toBe(409);
        expect(await OrderModel.countDocuments()).toBe(1);
    });

    it('serializes concurrent order creation with one token to one order', async () => {
        const upload = await uploadFiles();
        const body = makeOrderPayload(upload);
        const responses = await Promise.all([submitOrder(body), submitOrder(body)]);
        expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
        const orders = await Promise.all(responses.map((response) => response.json()));
        expect(orders[0].orderId).toBe(orders[1].orderId);
        expect(await OrderModel.countDocuments()).toBe(1);
    });

    it('rolls back batch and file claims with a failed order insert, then permits retry', async () => {
        const { sendWorkflowEmail } = await import('@/lib/email');
        const upload = await uploadFiles();
        const body = makeOrderPayload(upload);
        const createSpy = vi.spyOn(OrderModel, 'create').mockRejectedValueOnce(new Error('injected order insert failure'));
        expect((await submitOrder(body)).status).toBe(500);
        expect(sendWorkflowEmail).not.toHaveBeenCalled();
        createSpy.mockRestore();
        const batch = await CustomerUploadBatch.findOne({ fileIds: upload.files }).lean();
        const file = await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(upload.files[0]) });
        expect(batch?.claimedOrderId).toBeUndefined();
        expect(file?.metadata?.claimedOrderId).toBeUndefined();
        expect((await submitOrder(body)).status).toBe(201);
        expect(sendWorkflowEmail).toHaveBeenCalledTimes(2);
    });

    it('retries a transient transaction error without double-claiming the batch', async () => {
        const upload = await uploadFiles();
        const transient = Object.assign(new Error('injected transient transaction error'), {
            hasErrorLabel: (label: string) => label === 'TransientTransactionError',
        });
        const originalCreate = OrderModel.create.bind(OrderModel);
        const createSpy = vi.spyOn(OrderModel, 'create').mockRejectedValueOnce(transient).mockImplementation(originalCreate);
        const response = await submitOrder(makeOrderPayload(upload));
        expect(response.status).toBe(201);
        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(await OrderModel.countDocuments()).toBe(1);
        expect(await CustomerUploadBatch.countDocuments({ claimedOrderId: { $exists: true } })).toBe(1);
    });

    it('cleans up GridFS files when persisting the upload batch fails', async () => {
        const createSpy = vi.spyOn(CustomerUploadBatch, 'create').mockRejectedValueOnce(new Error('injected batch insert failure'));
        const form = new FormData();
        form.append('email', 'customer@example.test');
        form.append('files', new File([new Uint8Array(makePdf())], 'ref.pdf', { type: 'application/pdf' }));
        const response = await uploadRoute(new NextRequest('http://localhost/api/upload', {
            method: 'POST', headers: { 'x-vercel-forwarded-for': `192.0.2.${ipSequence++}` }, body: form,
        }));
        createSpy.mockRestore();
        expect(response.status).toBe(500);
        expect(await mongoose.connection.db!.collection('uploads.files').countDocuments()).toBe(0);
        expect(await CustomerUploadBatch.countDocuments()).toBe(0);
    });

    it('keeps order-linked files protected by existing 15-day retention checks', async () => {
        const upload = await uploadFiles();
        const orderResponse = await submitOrder(makeOrderPayload(upload));
        expect(orderResponse.status).toBe(201);
        const oldDate = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
        await mongoose.connection.db!.collection('uploads.files').updateOne(
            { _id: new mongoose.Types.ObjectId(upload.files[0]) }, { $set: { uploadDate: oldDate } }
        );
        await cleanupExpiredFiles(new Date());
        expect(await mongoose.connection.db!.collection('uploads.files').countDocuments({ _id: new mongoose.Types.ObjectId(upload.files[0]) })).toBe(1);
    });

    it('preserves writer and admin authorization for order-linked reference downloads', async () => {
        const upload = await uploadFiles();
        const order = await (await submitOrder(makeOrderPayload(upload))).json();
        const writerId = new mongoose.Types.ObjectId();
        await UserModel.create({
            _id: writerId,
            name: 'Approved Writer',
            email: 'writer@example.test',
            passwordHash: 'unused-test-hash',
            createdAt: new Date().toISOString(),
            role: 'writer',
            applicationStatus: 'approved',
            isAvailable: true,
        });
        await OrderModel.updateOne({ orderId: order.orderId }, {
            $set: { assignedWriterId: writerId.toString(), assignmentStatus: 'accepted', assignmentVersion: 1 },
        });

        const writerToken = createToken({ sub: writerId.toString(), role: 'writer', email: 'writer@example.test' });
        const writerResponse = await getFileRoute(
            new NextRequest(`http://localhost/api/files/${upload.files[0]}`, { headers: { cookie: `session=${writerToken}` } }),
            { params: Promise.resolve({ id: upload.files[0] }) }
        );
        expect(writerResponse.status).toBe(200);

        const strangerToken = createToken({ sub: new mongoose.Types.ObjectId().toString(), role: 'writer', email: 'stranger@example.test' });
        const strangerResponse = await getFileRoute(
            new NextRequest(`http://localhost/api/files/${upload.files[0]}`, { headers: { cookie: `session=${strangerToken}` } }),
            { params: Promise.resolve({ id: upload.files[0] }) }
        );
        expect(strangerResponse.status).toBe(403);

        const adminToken = createToken({ sub: 'test-admin', role: 'admin' });
        const adminResponse = await getFileRoute(
            new NextRequest(`http://localhost/api/files/${upload.files[0]}`, { headers: { cookie: `session=${adminToken}` } }),
            { params: Promise.resolve({ id: upload.files[0] }) }
        );
        expect(adminResponse.status).toBe(200);
        expect(adminResponse.headers.get('content-type')).toBe('application/pdf');
        expect(adminResponse.headers.get('content-disposition')).toMatch(/^inline;/);
        expect(adminResponse.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('validates writer submissions before storing and serves them as safe attachments', async () => {
        const referenceUpload = await uploadFiles();
        const order = await (await submitOrder(makeOrderPayload(referenceUpload))).json();
        const writerId = new mongoose.Types.ObjectId();
        await UserModel.create({
            _id: writerId, name: 'Approved Writer', email: 'writer@example.test', passwordHash: 'unused-test-hash',
            createdAt: new Date().toISOString(), role: 'writer', applicationStatus: 'approved', isAvailable: true,
        });
        const assignedAt = new Date().toISOString();
        await OrderModel.updateOne({ orderId: order.orderId }, { $set: {
            assignedWriterId: writerId.toString(), assignmentStatus: 'accepted', assignmentVersion: 1,
            writerWorkflowStatus: 'assigned',
            assignmentHistory: [{ writerId: writerId.toString(), assignedAt, assignedByAdminId: 'test-admin', assignmentVersion: 1, status: 'accepted', respondedAt: assignedAt }],
        } });

        const writerToken = createToken({ sub: writerId.toString(), role: 'writer', email: 'writer@example.test' });
        const form = new FormData();
        form.append('assignmentVersion', '1');
        form.append('submissionFile', new File([new Uint8Array(makePdf())], 'final.pdf', { type: 'application/pdf' }));
        const submissionResponse = await writerSubmissionRoute(new NextRequest(`http://localhost/api/writer/orders/${order.orderId}/submission`, {
            method: 'POST', headers: { cookie: `session=${writerToken}` }, body: form,
        }), { params: Promise.resolve({ id: order.orderId }) });
        expect(submissionResponse.status).toBe(200);
        const updated = await OrderModel.findOne({ orderId: order.orderId }).lean();
        const submittedFileId = updated?.writerSubmissions?.[0]?.fileId;
        expect(submittedFileId).toBeTruthy();
        const stored = await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(submittedFileId) });
        expect(stored?.metadata?.fileValidationVersion).toBe(1);
        expect(stored?.metadata?.validatedContentType).toBe('application/pdf');
        expect(await FileRetentionTask.findOne({ fileId: new mongoose.Types.ObjectId(submittedFileId!) }).lean()).toMatchObject({
            reason: 'orphaned-writer-submission', state: 'pending',
        });
        await cleanupExpiredFiles(new Date());
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(submittedFileId!) })).not.toBeNull();

        const download = await getFileRoute(
            new NextRequest(`http://localhost/api/files/${submittedFileId}`, { headers: { cookie: `session=${writerToken}` } }),
            { params: Promise.resolve({ id: submittedFileId! }) }
        );
        expect(download.status).toBe(200);
        expect(download.headers.get('content-type')).toBe('application/pdf');
        expect(download.headers.get('content-disposition')).toMatch(/^inline;/);
        expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('validates admin delivery files and keeps completed delivery semantics', async () => {
        const referenceUpload = await uploadFiles();
        const order = await (await submitOrder(makeOrderPayload(referenceUpload))).json();
        await OrderModel.updateOne({ orderId: order.orderId }, { $set: { orderStatus: 'In Progress' } });
        const adminToken = createToken({ sub: 'test-admin', role: 'admin' });
        const form = new FormData();
        form.append('orderStatus', 'Completed');
        form.append('deliveryFile', new File([new Uint8Array(makePdf())], 'delivery.pdf', { type: 'application/pdf' }));
        const response = await adminOrderRoute(new NextRequest(`http://localhost/api/orders/${order.orderId}`, {
            method: 'PUT', headers: { cookie: `session=${adminToken}` }, body: form,
        }), { params: Promise.resolve({ id: order.orderId }) });
        expect(response.status).toBe(200);
        const completed = await OrderModel.findOne({ orderId: order.orderId }).lean();
        expect(completed?.orderStatus).toBe('Completed');
        expect(completed?.physicalDeliveryStatus).toBe('Pending');
        expect(completed?.deliveryFile).toBeTruthy();
        const stored = await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(completed!.deliveryFile) });
        expect(stored?.metadata?.fileValidationVersion).toBe(1);
        expect(stored?.metadata?.validatedContentType).toBe('application/pdf');
    });
});

describe('file retention safety integration', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('deletes an abandoned, unreferenced customer upload after 15 days', async () => {
        const upload = await uploadFiles();
        const fileId = new mongoose.Types.ObjectId(upload.files[0]);
        const now = new Date();
        await mongoose.connection.db!.collection('uploads.files').updateOne(
            { _id: fileId }, { $set: { uploadDate: new Date(now.getTime() - 16 * DAY_MS) } }
        );

        const result = await cleanupExpiredFiles(now);

        expect(result.deleted).toBe(1);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: fileId })).toBeNull();
        expect(await mongoose.connection.db!.collection('uploads.chunks').countDocuments({ files_id: fileId })).toBe(0);
        expect(await FileRetentionTask.countDocuments({ fileId })).toBe(0);
    });

    it('retains a completed-order file shared by multiple orders', async () => {
        const upload = await uploadFiles();
        const fileId = upload.files[0];
        const oldCompletion = new Date(Date.now() - 16 * DAY_MS).toISOString();
        await createRetentionOrder({ orderId: 'WX-20260101-9101', fileIds: [fileId], orderStatus: 'Completed', completedAt: oldCompletion });
        await createRetentionOrder({ orderId: 'WX-20260101-9102', fileIds: [fileId], orderStatus: 'In Progress' });

        const result = await cleanupExpiredFiles(new Date());

        expect(result.sharedReferences).toBe(1);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(fileId) })).not.toBeNull();
        expect(await FileRetentionTask.findOne({ fileId: new mongoose.Types.ObjectId(fileId) }).lean()).toMatchObject({ state: 'retained-shared' });
    });

    it('does not delete completed-order files before 15 days have elapsed', async () => {
        const upload = await uploadFiles();
        const fileId = upload.files[0];
        const completion = new Date(Date.now() - 14 * DAY_MS).toISOString();
        await createRetentionOrder({ orderId: 'WX-20260101-9201', fileIds: [fileId], orderStatus: 'Completed', completedAt: completion });

        const result = await cleanupExpiredFiles(new Date());

        expect(result.referencesQueued).toBe(0);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(fileId) })).not.toBeNull();
    });

    it('deletes completed-order files after 15 days have elapsed', async () => {
        const upload = await uploadFiles();
        const fileId = new mongoose.Types.ObjectId(upload.files[0]);
        const completion = new Date(Date.now() - 16 * DAY_MS).toISOString();
        await createRetentionOrder({ orderId: 'WX-20260101-9301', fileIds: [fileId.toString()], orderStatus: 'Completed', completedAt: completion });

        const result = await cleanupExpiredFiles(new Date());

        expect(result.deleted).toBe(1);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: fileId })).toBeNull();
        expect(await mongoose.connection.db!.collection('uploads.chunks').countDocuments({ files_id: fileId })).toBe(0);
    });

    it.each([
        ['missing', undefined],
        ['invalid', 'not-a-completion-date'],
    ])('retains completed-order files when completedAt is %s', async (_label, completedAt) => {
        const upload = await uploadFiles();
        const fileId = upload.files[0];
        await createRetentionOrder({
            orderId: _label === 'missing' ? 'WX-20260101-9401' : 'WX-20260101-9402',
            fileIds: [fileId],
            orderStatus: 'Completed',
            ...(completedAt === undefined ? {} : { completedAt }),
        });

        const result = await cleanupExpiredFiles(new Date());

        expect(result.referencesQueued).toBe(0);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(fileId) })).not.toBeNull();
    });

    it('leaves cleanup tasks and file data retryable after a transaction failure', async () => {
        const upload = await uploadFiles();
        const fileId = new mongoose.Types.ObjectId(upload.files[0]);
        const now = new Date();
        await mongoose.connection.db!.collection('uploads.files').updateOne(
            { _id: fileId }, { $set: { uploadDate: new Date(now.getTime() - 16 * DAY_MS) } }
        );
        const chunks = mongoose.connection.db!.collection('uploads.chunks');
        const deleteChunks = vi.spyOn(Object.getPrototypeOf(chunks), 'deleteMany')
            .mockRejectedValueOnce(new Error('injected transaction failure'));

        const failedRun = await cleanupExpiredFiles(now);

        expect(failedRun.failures).toBe(1);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: fileId })).not.toBeNull();
        expect(await FileRetentionTask.findOne({ fileId }).lean()).toMatchObject({ state: 'pending', attempts: 1 });
        deleteChunks.mockRestore();

        const retry = await cleanupExpiredFiles(now);

        expect(retry.deleted).toBe(1);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: fileId })).toBeNull();
        expect(await FileRetentionTask.countDocuments({ fileId })).toBe(0);
    });

    it.each([
        ['missing', undefined, undefined, 503],
        ['incorrect', 'configured-test-secret', 'Bearer wrong-secret', 401],
    ])('rejects cron cleanup when the secret is %s', async (_label, configuredSecret, authorization, expectedStatus) => {
        const previousSecret = process.env.CRON_SECRET;
        if (configuredSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = configuredSecret;
        try {
            const request = new NextRequest('http://localhost/api/cron/cleanup-files', {
                headers: authorization ? { authorization } : {},
            });
            expect((await cleanupCronRoute(request)).status).toBe(expectedStatus);
        } finally {
            if (previousSecret === undefined) delete process.env.CRON_SECRET;
            else process.env.CRON_SECRET = previousSecret;
        }
    });

    it('processes no more than 200 cleanup tasks in a run', async () => {
        const now = new Date();
        await FileRetentionTask.insertMany(Array.from({ length: 201 }, (_, index) => ({
            fileId: new mongoose.Types.ObjectId(),
            reason: 'abandoned-upload',
            eligibleAt: new Date(now.getTime() - 1),
            state: 'pending',
            attempts: 0,
            createdAt: new Date(now.getTime() - 1000 + index),
        })));

        const result = await cleanupExpiredFiles(now);

        expect(result.tasksAttempted).toBe(200);
        expect(result.pending).toBe(1);
        expect(await FileRetentionTask.countDocuments({ state: 'pending' })).toBe(1);
    });

    it('attaches a replacement delivery before scheduling the old delivery for cleanup', async () => {
        const { orderId, oldDeliveryFileId } = await createInProgressOrderWithOldDelivery();
        const scheduledAt = new Date();

        const response = await makeAdminDeliveryRequest(orderId);

        expect(response.status).toBe(200);
        const updatedOrder = await OrderModel.findOne({ orderId }).lean();
        expect(updatedOrder?.orderStatus).toBe('Completed');
        expect(updatedOrder?.deliveryFile).toBeTruthy();
        expect(updatedOrder?.deliveryFile).not.toBe(oldDeliveryFileId);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(updatedOrder!.deliveryFile) })).not.toBeNull();
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(oldDeliveryFileId) })).not.toBeNull();
        const task = await FileRetentionTask.findOne({ fileId: new mongoose.Types.ObjectId(oldDeliveryFileId) }).lean();
        expect(task).toMatchObject({ reason: 'replaced-delivery', state: 'pending' });
        expect(task?.eligibleAt.getTime()).toBeGreaterThanOrEqual(scheduledAt.getTime() + 15 * DAY_MS);
    });

    it('does not schedule or delete the old delivery when the order update fails', async () => {
        const { orderId, oldDeliveryFileId } = await createInProgressOrderWithOldDelivery();
        vi.spyOn(orderDbModule, 'updateOrderWithCompletionSnapshot').mockResolvedValueOnce(null);

        const response = await makeAdminDeliveryRequest(orderId);

        expect(response.status).toBe(409);
        expect((await OrderModel.findOne({ orderId }).lean())?.deliveryFile).toBe(oldDeliveryFileId);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: new mongoose.Types.ObjectId(oldDeliveryFileId) })).not.toBeNull();
        expect(await FileRetentionTask.countDocuments({ fileId: new mongoose.Types.ObjectId(oldDeliveryFileId) })).toBe(0);
    });

    it('retains a replaced delivery file that is still referenced by another order', async () => {
        const { orderId, oldDeliveryFileId } = await createInProgressOrderWithOldDelivery();
        const sharingOrder = await createRetentionOrder({ orderId: 'WX-20260101-9501', fileIds: [] });
        await OrderModel.updateOne({ _id: sharingOrder._id }, { $set: { deliveryFile: oldDeliveryFileId } });
        expect((await makeAdminDeliveryRequest(orderId)).status).toBe(200);
        const oldFileObjectId = new mongoose.Types.ObjectId(oldDeliveryFileId);
        await FileRetentionTask.updateOne({ fileId: oldFileObjectId }, { $set: { eligibleAt: new Date(Date.now() - 1) } });

        const result = await cleanupExpiredFiles(new Date());

        expect(result.sharedReferences).toBe(1);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: oldFileObjectId })).not.toBeNull();
        expect(await FileRetentionTask.findOne({ fileId: oldFileObjectId }).lean()).toMatchObject({ state: 'retained-shared' });
    });

    it('does not clean a replaced delivery before its 15-day eligibility time', async () => {
        const { orderId, oldDeliveryFileId } = await createInProgressOrderWithOldDelivery();
        expect((await makeAdminDeliveryRequest(orderId)).status).toBe(200);
        const oldFileObjectId = new mongoose.Types.ObjectId(oldDeliveryFileId);
        const task = await FileRetentionTask.findOne({ fileId: oldFileObjectId }).lean();
        assert(task, 'replacement should create a retention task');
        expect(task.eligibleAt.getTime()).toBeGreaterThan(Date.now());

        const result = await cleanupExpiredFiles(new Date());

        expect(result.tasksAttempted).toBe(0);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: oldFileObjectId })).not.toBeNull();
        expect(await FileRetentionTask.findOne({ fileId: oldFileObjectId }).lean()).toMatchObject({ state: 'pending' });
    });

    it('deletes an unreferenced replaced delivery after its retention period', async () => {
        const { orderId, oldDeliveryFileId } = await createInProgressOrderWithOldDelivery();
        expect((await makeAdminDeliveryRequest(orderId)).status).toBe(200);
        const oldFileObjectId = new mongoose.Types.ObjectId(oldDeliveryFileId);
        const task = await FileRetentionTask.findOne({ fileId: oldFileObjectId }).lean();
        assert(task, 'replacement should create a retention task');

        const result = await cleanupExpiredFiles(new Date(task.eligibleAt.getTime() + 1));

        expect(result.deleted).toBeGreaterThanOrEqual(1);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: oldFileObjectId })).toBeNull();
        expect(await mongoose.connection.db!.collection('uploads.chunks').countDocuments({ files_id: oldFileObjectId })).toBe(0);
        expect(await FileRetentionTask.countDocuments({ fileId: oldFileObjectId })).toBe(0);
    });

    it('keeps a writer file after a definite order-update failure and schedules eventual cleanup', async () => {
        const { orderId, writerToken } = await createAcceptedWriterAssignment();
        mockWriterOrderUpdateResult(async () => null);

        const response = await makeWriterSubmissionRequest(orderId, writerToken);

        expect(response.status).toBe(409);
        const file = await mongoose.connection.db!.collection('uploads.files').findOne({ 'metadata.purpose': 'writer-submission' });
        assert(file?._id instanceof mongoose.Types.ObjectId, 'failed submission should leave its uploaded file for deferred cleanup');
        const task = await FileRetentionTask.findOne({ fileId: file._id }).lean();
        expect(task).toMatchObject({ reason: 'orphaned-writer-submission', state: 'pending' });
        expect(task!.eligibleAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 15 * DAY_MS - 5000);
        expect(await OrderModel.exists({ 'writerSubmissions.fileId': file._id.toString() })).toBeNull();
    });

    it('does not immediately delete a writer file when the order update outcome is ambiguous', async () => {
        const { orderId, writerToken } = await createAcceptedWriterAssignment();
        mockWriterOrderUpdateResult(async () => { throw new Error('ambiguous database update outcome'); });

        const response = await makeWriterSubmissionRequest(orderId, writerToken);

        expect(response.status).toBe(500);
        const file = await mongoose.connection.db!.collection('uploads.files').findOne({ 'metadata.purpose': 'writer-submission' });
        assert(file?._id instanceof mongoose.Types.ObjectId, 'ambiguous submission should leave the file intact');
        expect(await FileRetentionTask.findOne({ fileId: file._id }).lean()).toMatchObject({
            reason: 'orphaned-writer-submission', state: 'pending',
        });
    });

    it('retains an eligible writer orphan when another order references it', async () => {
        const { orderId, writerId, writerToken } = await createAcceptedWriterAssignment();
        mockWriterOrderUpdateResult(async () => null);
        expect((await makeWriterSubmissionRequest(orderId, writerToken)).status).toBe(409);
        const file = await mongoose.connection.db!.collection('uploads.files').findOne({ 'metadata.purpose': 'writer-submission' });
        assert(file?._id instanceof mongoose.Types.ObjectId, 'test submission file should exist');
        const otherOrder = await createRetentionOrder({ orderId: 'WX-20260101-9601', fileIds: [] });
        await OrderModel.updateOne({ _id: otherOrder._id }, { $set: { writerSubmissions: [{
            submissionId: 'shared-submission', writerId, assignmentVersion: 1, fileId: file._id.toString(),
            submittedAt: new Date().toISOString(), reviewStatus: 'approved',
        }] } });
        await mongoose.connection.db!.collection('uploads.files').updateOne(
            { _id: file._id }, { $set: { uploadDate: new Date(Date.now() - 16 * DAY_MS) } }
        );
        await FileRetentionTask.updateOne({ fileId: file._id }, { $set: { eligibleAt: new Date(Date.now() - 1) } });

        await cleanupExpiredFiles(new Date());

        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: file._id })).not.toBeNull();
        expect(await FileRetentionTask.countDocuments({ fileId: file._id })).toBe(0);
    });

    it('does not clean a writer orphan before 15 days have elapsed', async () => {
        const { orderId, writerToken } = await createAcceptedWriterAssignment();
        mockWriterOrderUpdateResult(async () => null);
        expect((await makeWriterSubmissionRequest(orderId, writerToken)).status).toBe(409);
        const file = await mongoose.connection.db!.collection('uploads.files').findOne({ 'metadata.purpose': 'writer-submission' });
        assert(file?._id instanceof mongoose.Types.ObjectId, 'test submission file should exist');

        const result = await cleanupExpiredFiles(new Date());

        expect(result.tasksAttempted).toBe(0);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: file._id })).not.toBeNull();
        expect(await FileRetentionTask.findOne({ fileId: file._id }).lean()).toMatchObject({ state: 'pending' });
    });

    it('cleans an unreferenced writer orphan after its 15-day grace period', async () => {
        const { orderId, writerToken } = await createAcceptedWriterAssignment();
        mockWriterOrderUpdateResult(async () => null);
        expect((await makeWriterSubmissionRequest(orderId, writerToken)).status).toBe(409);
        const file = await mongoose.connection.db!.collection('uploads.files').findOne({ 'metadata.purpose': 'writer-submission' });
        assert(file?._id instanceof mongoose.Types.ObjectId, 'test submission file should exist');
        const task = await FileRetentionTask.findOne({ fileId: file._id }).lean();
        assert(task, 'orphan upload should have a cleanup task');

        const result = await cleanupExpiredFiles(new Date(task.eligibleAt.getTime() + 1));

        expect(result.deleted).toBeGreaterThanOrEqual(1);
        expect(await mongoose.connection.db!.collection('uploads.files').findOne({ _id: file._id })).toBeNull();
        expect(await mongoose.connection.db!.collection('uploads.chunks').countDocuments({ files_id: file._id })).toBe(0);
        expect(await FileRetentionTask.countDocuments({ fileId: file._id })).toBe(0);
    });
});

describe('admin writer submission approval and completion', () => {
    it('shows pending submissions in the admin review queue and automatically completes on approval', async () => {
        const fixture = await createPendingWriterSubmission();
        const { sendWorkflowEmail } = await import('@/lib/email');
        vi.mocked(sendWorkflowEmail).mockClear();

        const pendingResponse = await makeAdminReviewQueueRequest();
        expect(pendingResponse.status).toBe(200);
        const pendingQueue = await pendingResponse.json();
        expect(pendingQueue).toHaveLength(1);
        expect(pendingQueue[0]).toMatchObject({
            orderId: fixture.orderId,
            orderStatus: 'In Progress',
            customer: {
                name: 'Ownership Test Customer',
                collegeName: 'Test College',
                yearOfStudying: '3rd Year',
                branch: 'Computer Science',
            },
            writer: { name: 'Retention Test Writer', email: 'retention-writer@example.test' },
            submissionId: fixture.submissionId,
            assignmentVersion: 1,
            fileUrl: expect.stringContaining('/api/files/'),
        });

        const approvalBody = { submissionId: fixture.submissionId, assignmentVersion: 1, decision: 'approved' };
        const response = await makeAdminReviewRequest(fixture.orderId, approvalBody);
        const result = await response.json();
        expect(response.status).toBe(200);
        expect(result).toMatchObject({
            orderId: fixture.orderId,
            orderStatus: 'Completed',
            physicalDeliveryStatus: 'Pending',
            workflowStatus: 'approved',
            currentSubmissionId: fixture.submissionId,
            approvedSubmissionId: fixture.submissionId,
        });
        expect(typeof result.completedAt).toBe('string');

        const order = await OrderModel.findOne({ orderId: fixture.orderId }).lean();
        const approved = order?.writerSubmissions?.find((submission) => submission.submissionId === fixture.submissionId);
        expect(order).toMatchObject({
            orderStatus: 'Completed',
            physicalDeliveryStatus: 'Pending',
            deliveryFile: result.deliveryFile,
            writerWorkflowStatus: 'approved',
            approvedSubmissionId: fixture.submissionId,
            completedByWriterId: fixture.writerId,
            completedAssignmentVersion: 1,
        });
        expect(order?.completedAt).toBeTruthy();
        expect(approved).toMatchObject({
            reviewStatus: 'approved',
            fileId: result.deliveryFile,
            reviewedByAdminId: 'test-admin',
        });
        expect(approved?.reviewedAt).toBeTruthy();

        const reviewedQueue = await makeAdminReviewQueueRequest();
        expect(await reviewedQueue.json()).toEqual([]);

        expect(sendWorkflowEmail).toHaveBeenCalledTimes(2);
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({
            event: 'writer_submission_approved',
            idempotencyKey: `writer-review/${fixture.orderId}/${fixture.submissionId}/approved`,
        }));
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({
            event: 'approved_work_delivered',
            to: 'customer@example.test',
            action: { label: 'View Completed Work', path: `/track?orderId=${encodeURIComponent(fixture.orderId)}` },
            idempotencyKey: `approved-work-delivered/${fixture.orderId}/${fixture.submissionId}`,
        }));

        const duplicate = await makeAdminReviewRequest(fixture.orderId, approvalBody);
        expect(duplicate.status).toBe(409);
        expect(sendWorkflowEmail).toHaveBeenCalledTimes(2);

        const adminToken = createToken({ sub: 'test-admin', role: 'admin' });
        const physicalResponse = await adminOrderRoute(new NextRequest(`http://localhost/api/orders/${fixture.orderId}`, {
            method: 'PUT',
            headers: { cookie: `session=${adminToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ physicalDeliveryStatus: 'Delivered' }),
        }), { params: Promise.resolve({ id: fixture.orderId }) });
        expect(physicalResponse.status).toBe(200);
        expect(await OrderModel.findOne({ orderId: fixture.orderId }).lean()).toMatchObject({
            orderStatus: 'Completed',
            physicalDeliveryStatus: 'Delivered',
        });
    });

    it('does not complete on a revision request, then completes an approved revision while preserving history', async () => {
        const fixture = await createPendingWriterSubmission();
        const { sendWorkflowEmail } = await import('@/lib/email');
        vi.mocked(sendWorkflowEmail).mockClear();

        const revisionResponse = await makeAdminReviewRequest(fixture.orderId, {
            submissionId: fixture.submissionId,
            assignmentVersion: fixture.assignmentVersion,
            decision: 'revision_required',
            feedback: 'Please revise the structure and clarify the conclusion.',
        });
        expect(revisionResponse.status).toBe(200);
        expect(await OrderModel.findOne({ orderId: fixture.orderId }).lean()).toMatchObject({
            orderStatus: 'In Progress',
            writerWorkflowStatus: 'revision_required',
        });
        const firstSubmission = (await OrderModel.findOne({ orderId: fixture.orderId }).lean())?.writerSubmissions?.[0];
        expect(firstSubmission).toMatchObject({
            submissionId: fixture.submissionId,
            reviewStatus: 'revision_required',
            reviewFeedback: 'Please revise the structure and clarify the conclusion.',
        });
        expect(await (await makeAdminReviewQueueRequest()).json()).toEqual([]);

        const newSubmissionResponse = await makeWriterSubmissionRequest(fixture.orderId, fixture.writerToken);
        expect(newSubmissionResponse.status).toBe(200);
        const newSubmission = await newSubmissionResponse.json();
        expect(newSubmission.submissionId).not.toBe(fixture.submissionId);
        vi.mocked(sendWorkflowEmail).mockClear();

        const approvalResponse = await makeAdminReviewRequest(fixture.orderId, {
            submissionId: newSubmission.submissionId,
            assignmentVersion: fixture.assignmentVersion,
            decision: 'approved',
        });
        expect(approvalResponse.status).toBe(200);
        const completed = await OrderModel.findOne({ orderId: fixture.orderId }).lean();
        expect(completed).toMatchObject({ orderStatus: 'Completed', physicalDeliveryStatus: 'Pending', writerWorkflowStatus: 'approved' });
        expect(completed?.writerSubmissions).toHaveLength(2);
        expect(completed?.writerSubmissions?.[0]).toMatchObject({ reviewStatus: 'revision_required' });
        expect(completed?.writerSubmissions?.[1]).toMatchObject({
            submissionId: newSubmission.submissionId,
            reviewStatus: 'approved',
        });
        expect(sendWorkflowEmail).toHaveBeenCalledWith(expect.objectContaining({ event: 'approved_work_delivered' }));
    });

    it('publishes only safe review fields immediately and enforces customer order ownership', async () => {
        const customerId = new mongoose.Types.ObjectId(defaultCustomerId);
        await UserModel.create({ _id: customerId, name: 'Order Owner', email: defaultCustomerEmail, passwordHash: 'unused-test-hash', createdAt: new Date().toISOString(), role: 'user' });
        const fixture = await createPendingWriterSubmission();
        const approval = await makeAdminReviewRequest(fixture.orderId, {
            submissionId: fixture.submissionId, assignmentVersion: fixture.assignmentVersion, decision: 'approved',
        });
        expect(approval.status).toBe(200);

        const reviewBody = { rating: 5, displayName: 'Riya K.', text: '<script>Great support</script> Clear updates and a helpful delivery.' };
        const submitted = await makeCustomerReviewRequest(fixture.orderId, reviewBody);
        expect(submitted.status).toBe(200);
        expect(await submitted.json()).toMatchObject({ feedbackSubmitted: true, rating: 5, displayName: 'Riya K.' });

        const unauthorized = await makeCustomerReviewRequest(fixture.orderId, reviewBody, null);
        expect(unauthorized.status).toBe(401);
        const duplicate = await makeCustomerReviewRequest(fixture.orderId, reviewBody);
        expect(duplicate.status).toBe(409);
        const otherCustomerId = '507f1f77bcf86cd799439012';
        await UserModel.create({ _id: new mongoose.Types.ObjectId(otherCustomerId), name: 'Other Customer', email: 'other@example.test', passwordHash: 'unused-test-hash', createdAt: new Date().toISOString(), role: 'user' });
        const otherCustomer = customerSession('other@example.test', otherCustomerId);
        const crossAccountSubmit = await makeCustomerReviewRequest(fixture.orderId, reviewBody, otherCustomer);
        expect(crossAccountSubmit.status).toBe(404);

        const publicResponse = await publicReviewsRoute();
        expect(publicResponse.status).toBe(200);
        const publicBody = await publicResponse.json();
        expect(publicBody.reviews).toContainEqual({
            displayName: 'Riya K.', rating: 5, text: reviewBody.text, verifiedCustomer: true,
        });
        expect(JSON.stringify(publicBody)).not.toMatch(/email|orderId|reviewerUserId|writerId|customer@example\.test/i);
    });

    it('rolls back submission approval, completion, and file metadata when the transaction update fails', async () => {
        const fixture = await createPendingWriterSubmission();
        const { sendWorkflowEmail } = await import('@/lib/email');
        vi.mocked(sendWorkflowEmail).mockClear();
        const fileBefore = await mongoose.connection.db!.collection('uploads.files').findOne({ 'metadata.purpose': 'writer-submission' });
        assert(fileBefore?._id instanceof mongoose.Types.ObjectId, 'writer submission file should exist before review');
        const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(OrderModel, 'updateOne').mockImplementationOnce((() => {
            throw new Error('injected approval transaction failure');
        }) as never);

        const response = await makeAdminReviewRequest(fixture.orderId, {
            submissionId: fixture.submissionId,
            assignmentVersion: fixture.assignmentVersion,
            decision: 'approved',
        });
        expect(response.status).toBe(500);

        const order = await OrderModel.findOne({ orderId: fixture.orderId }).lean();
        expect(order).toMatchObject({ orderStatus: 'In Progress', writerWorkflowStatus: 'submitted_for_review' });
        expect(order?.deliveryFile).toBeUndefined();
        expect(order?.completedAt).toBeUndefined();
        expect(order?.writerSubmissions?.[0]).toMatchObject({ reviewStatus: 'pending_review' });
        const fileAfter = await mongoose.connection.db!.collection('uploads.files').findOne({ _id: fileBefore._id });
        expect(fileAfter?.metadata?.lastOrderStatusChangeAt).toBeUndefined();
        expect(sendWorkflowEmail).not.toHaveBeenCalled();
        logError.mockRestore();
    });

    it('rejects unauthorized and non-admin review decisions', async () => {
        const fixture = await createPendingWriterSubmission();
        const decision = { submissionId: fixture.submissionId, assignmentVersion: 1, decision: 'approved' };
        const unauthorized = await adminSubmissionDecisionRoute(new NextRequest(`http://localhost/api/admin/submissions/${fixture.orderId}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision),
        }), { params: Promise.resolve({ id: fixture.orderId }) });
        expect(unauthorized.status).toBe(401);

        const forbidden = await makeAdminReviewRequest(fixture.orderId, decision, fixture.writerToken);
        expect(forbidden.status).toBe(403);
        expect(await OrderModel.findOne({ orderId: fixture.orderId }).lean()).toMatchObject({
            orderStatus: 'In Progress',
            writerWorkflowStatus: 'submitted_for_review',
        });
    });
});
