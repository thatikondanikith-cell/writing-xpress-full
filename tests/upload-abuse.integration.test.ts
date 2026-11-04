import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MongoMemoryServer } from 'mongodb-memory-server';

const uploadMock = vi.hoisted(() => {
    let nextFileId = 1;
    return {
        uploadFileToGridFS: vi.fn(async () => `507f1f77bcf86cd799${String(nextFileId++).padStart(6, '0')}`),
        deleteFileFromGridFS: vi.fn(async () => undefined),
        reset: () => { nextFileId = 1; },
    };
});

vi.mock('@/lib/gridfs', () => uploadMock);

const MiB = 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * MiB;
const TEST_SECRET = 'upload-abuse-test-secret-only-32-bytes-minimum';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mongoTestDataRoot = resolve(projectRoot, '.mongodb-test-data');
const mongoTestRunToken = randomUUID();
const mongoTestRunDirectory = resolve(mongoTestDataRoot, `run-${process.pid}-${mongoTestRunToken}`);
const mongoTestDbPath = resolve(mongoTestRunDirectory, 'upload-abuse');
const mongoTestDatabaseName = `writing_xpress_upload_test_${randomUUID().replaceAll('-', '')}`;
const boundary = '----writing-xpress-upload-abuse-test-boundary';

let mongod: MongoMemoryServer | undefined;
let mongoose: typeof import('mongoose').default;
let OtpIpRateLimit: typeof import('@/lib/models/OtpIpRateLimit').default;
let CustomerUploadBatch: typeof import('@/lib/models/CustomerUploadBatch').default;
let uploadRoute: typeof import('@/app/api/upload/route').POST;
let fileValidationModule: typeof import('@/lib/file-validation');
let realValidateDocumentFile: typeof import('@/lib/file-validation').validateDocumentFile;
let getVercelClientIp: typeof import('@/lib/otp-ip-rate-limit').getVercelClientIp;
let mongoTestDbPathCreated = false;
let ipSequence = 10;

async function createMongoTestDbPath() {
    await mkdir(mongoTestDataRoot, { recursive: true });
    await mkdir(mongoTestRunDirectory, { recursive: true });
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    assert(relativeDbPath === `run-${process.pid}-${mongoTestRunToken}${sep}upload-abuse`, 'upload abuse MongoDB path must be this process suite directory');
    await mkdir(mongoTestDbPath);
    mongoTestDbPathCreated = true;
}

async function removeMongoTestDbPath() {
    if (!mongoTestDbPathCreated) return;
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    assert(relativeDbPath === `run-${process.pid}-${mongoTestRunToken}${sep}upload-abuse`, 'refusing to remove an unexpected upload abuse MongoDB path');
    await rm(mongoTestDbPath, { recursive: true });
    mongoTestDbPathCreated = false;
}

function nextIp() {
    return `203.0.113.${ipSequence++}`;
}

async function withNodeEnv<T>(nodeEnv: string, callback: () => T | Promise<T>): Promise<T> {
    const previous = process.env.NODE_ENV;
    Reflect.set(process.env, 'NODE_ENV', nodeEnv);
    try {
        return await callback();
    } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
        else Reflect.set(process.env, 'NODE_ENV', previous);
    }
}

function makeIpOnlyRequest(headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/upload', { method: 'POST', headers });
}

function makeFormRequest(
    sizes: number[],
    ip = nextIp(),
    extraHeaders: Record<string, string> = {},
    fileTypes: string[] = sizes.map(() => 'application/pdf')
) {
    const formData = new FormData();
    formData.append('email', 'Customer@Example.Test ');
    sizes.forEach((size, index) => {
        formData.append('files', new File([new Uint8Array(size)], `reference-${index}.pdf`, { type: fileTypes[index] }));
    });
    return new NextRequest('http://localhost/api/upload', {
        method: 'POST',
        headers: { 'x-vercel-forwarded-for': ip, ...extraHeaders },
        body: formData,
    });
}

function makeRawMultipartRequest(
    fileSizes: number[],
    options: { ip?: string; targetLength?: number; contentLength?: string } = {}
) {
    const chunks: Buffer[] = [];
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\nCustomer@Example.Test \r\n`));
    for (let index = 0; index < fileSizes.length; index += 1) {
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="reference-${index}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
        ));
        chunks.push(Buffer.alloc(fileSizes[index], 0x61));
        chunks.push(Buffer.from('\r\n'));
    }

    if (options.targetLength !== undefined) {
        const paddingHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="padding"\r\n\r\n`);
        const end = Buffer.from(`\r\n--${boundary}--\r\n`);
        const currentLength = chunks.reduce((total, chunk) => total + chunk.length, 0) + paddingHeader.length + end.length;
        const paddingLength = options.targetLength - currentLength;
        assert(paddingLength >= 0, 'target multipart length must fit the file parts and headers');
        chunks.push(paddingHeader, Buffer.alloc(paddingLength, 0x70), end);
    } else {
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
    }

    const body = Buffer.concat(chunks);
    const headers: Record<string, string> = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-vercel-forwarded-for': options.ip || nextIp(),
    };
    if (options.contentLength !== undefined) headers['content-length'] = options.contentLength;
    return new NextRequest('http://localhost/api/upload', {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
    });
}

async function makeRateLimitRow(ip: string) {
    const ipKey = createHmac('sha256', TEST_SECRET).update(`upload-ip\0${ip}`).digest('hex');
    await OtpIpRateLimit.create({
        ipKey,
        action: 'upload',
        events: [new Date()],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
}

beforeAll(async () => {
    if (process.env.WRITING_XPRESS_ISOLATED_TEST !== '1') {
        throw new Error('Use the isolated Vitest runner; direct upload integration test execution is disabled.');
    }
    Reflect.set(process.env, 'NODE_ENV', 'test');
    process.env.OTP_HASH_SECRET = TEST_SECRET;

    await createMongoTestDbPath();
    mongod = await MongoMemoryServer.create({
        instance: {
            ip: '127.0.0.1',
            dbPath: mongoTestDbPath,
            dbName: mongoTestDatabaseName,
            args: ['--setParameter', 'ttlMonitorSleepSecs=1'],
        },
    });
    const uri = mongod.getUri(mongoTestDatabaseName);
    const parsed = new URL(uri);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'test MongoDB must bind to loopback');
    assert(parsed.pathname.slice(1) === mongoTestDatabaseName, 'test MongoDB must use an isolated test database');
    process.env.MONGODB_URI = uri;

    const [mongooseModule, connectionModule, rateLimitModule, batchModule, routeModule, limiterModule, validationModule] = await Promise.all([
        import('mongoose'),
        import('@/lib/mongoose'),
        import('@/lib/models/OtpIpRateLimit'),
        import('@/lib/models/CustomerUploadBatch'),
        import('@/app/api/upload/route'),
        import('@/lib/otp-ip-rate-limit'),
        import('@/lib/file-validation'),
    ]);
    mongoose = mongooseModule.default;
    OtpIpRateLimit = rateLimitModule.default;
    CustomerUploadBatch = batchModule.default;
    uploadRoute = routeModule.POST;
    getVercelClientIp = limiterModule.getVercelClientIp;
    fileValidationModule = validationModule;
    realValidateDocumentFile = validationModule.validateDocumentFile;
    await connectionModule.connectDB();
    await Promise.all([OtpIpRateLimit.init(), CustomerUploadBatch.init()]);
}, 120_000);

beforeEach(async () => {
    await Promise.all([OtpIpRateLimit.deleteMany({}), CustomerUploadBatch.deleteMany({})]);
    uploadMock.uploadFileToGridFS.mockClear();
    uploadMock.deleteFileFromGridFS.mockClear();
    uploadMock.reset();
    vi.restoreAllMocks();
    vi.spyOn(fileValidationModule, 'validateDocumentFile').mockImplementation(async ({ filename, declaredMimeType, bytes }) => {
        if (declaredMimeType !== 'application/pdf' || !filename.toLowerCase().endsWith('.pdf')) {
            throw new fileValidationModule.InvalidDocumentFileError();
        }
        return { filename, extension: '.pdf', mimeType: 'application/pdf', bytes: Buffer.from(bytes), validationVersion: 1 };
    });
});

afterAll(async () => {
    try {
        if (mongoose) await mongoose.disconnect();
    } finally {
        try {
            if (mongod) await mongod.stop();
        } finally {
            await removeMongoTestDbPath();
        }
    }
});

describe('customer upload abuse protection', () => {
    it('creates a normalized-email upload batch and returns its one-time raw token', async () => {
        const response = await uploadRoute(makeFormRequest([1]));
        const result = await response.json();
        expect(response.status).toBe(200);
        expect(typeof result.uploadToken).toBe('string');
        expect(result.files).toHaveLength(1);
        const batch = await CustomerUploadBatch.findOne({ fileIds: result.files }).lean();
        expect(batch?.email).toBe('customer@example.test');
        expect(batch?.tokenHash).not.toBe(result.uploadToken);
        expect(batch?.batchId).toEqual(expect.any(String));
        expect(batch?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
    it('accepts exactly five files whose combined bytes equal 3.5 MiB', async () => {
        const sizes = [MiB, MiB, MiB, MiB / 4, MiB / 4];
        const response = await uploadRoute(makeFormRequest(sizes));
        expect(response.status).toBe(200);
        expect(uploadMock.uploadFileToGridFS).toHaveBeenCalledTimes(5);
    });

    it('logs only a fixed reason code when multipart form parsing fails', async () => {
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const request = new NextRequest('http://localhost/api/upload', {
            method: 'POST',
            headers: {
                'content-type': 'multipart/form-data; boundary=expected-boundary',
                'x-vercel-forwarded-for': nextIp(),
            },
            body: 'this is not a valid multipart body',
        });

        const response = await uploadRoute(request);
        expect(response.status).toBe(400);
        expect(diagnostic).toHaveBeenCalledWith('[upload] request rejected', { reason: 'form_data_parse_failed' });
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Customer@Example.Test');
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('this is not a valid multipart body');
    });

    it('accepts a 3.5 MiB file and a multipart request exactly 4 MiB long', async () => {
        const response = await uploadRoute(makeRawMultipartRequest([3.5 * MiB], { targetLength: MAX_REQUEST_BYTES }));
        expect(response.status, await response.clone().text()).toBe(200);
    });

    it('rejects more than five files with 413', async () => {
        const response = await uploadRoute(makeFormRequest([1, 1, 1, 1, 1, 1]));
        expect(response.status).toBe(413);
        expect(uploadMock.uploadFileToGridFS).not.toHaveBeenCalled();
    });

    it('validates every file type before starting any GridFS upload', async () => {
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const response = await uploadRoute(makeFormRequest([1, 1], nextIp(), {}, ['application/pdf', 'text/html']));
        expect(response.status).toBe(400);
        expect(diagnostic).toHaveBeenCalledWith('[upload] request rejected', { reason: 'document_invalid', fileIndex: 1 });
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Customer@Example.Test');
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('reference-1.pdf');
        expect(uploadMock.uploadFileToGridFS).not.toHaveBeenCalled();
    });

    it('rejects malformed PDF content before any GridFS upload', async () => {
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.mocked(fileValidationModule.validateDocumentFile).mockImplementationOnce(
            realValidateDocumentFile
        );
        const response = await uploadRoute(makeFormRequest([5]));
        expect(response.status).toBe(400);
        expect(diagnostic).toHaveBeenCalledWith('[upload] request rejected', { reason: 'pdf_too_short', fileIndex: 0 });
        expect(uploadMock.uploadFileToGridFS).not.toHaveBeenCalled();
    });

    it('deletes earlier GridFS uploads when a later upload fails and preserves the original error', async () => {
        const uploadError = new Error('injected second-file upload failure');
        const cleanupError = new Error('injected cleanup failure');
        uploadMock.uploadFileToGridFS
            .mockResolvedValueOnce('507f1f77bcf86cd799439012')
            .mockRejectedValueOnce(uploadError);
        uploadMock.deleteFileFromGridFS.mockRejectedValueOnce(cleanupError);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await uploadRoute(makeFormRequest([1, 1]));

        expect(response.status).toBe(500);
        expect(uploadMock.deleteFileFromGridFS).toHaveBeenCalledExactlyOnceWith('507f1f77bcf86cd799439012');
        expect(errorSpy).toHaveBeenCalledWith('Could not clean up a failed customer upload file:', cleanupError);
        expect(errorSpy).toHaveBeenCalledWith('Upload error:', uploadError);
    });

    it('rejects a file one byte over 3.5 MiB with 413', async () => {
        const response = await uploadRoute(makeRawMultipartRequest([3.5 * MiB + 1]));
        expect(response.status).toBe(413);
        expect(uploadMock.uploadFileToGridFS).not.toHaveBeenCalled();
    });

    it('rejects combined file data one byte over 3.5 MiB with 413', async () => {
        const response = await uploadRoute(makeRawMultipartRequest([2 * MiB, 1.5 * MiB + 1]));
        expect(response.status).toBe(413);
        expect(uploadMock.uploadFileToGridFS).not.toHaveBeenCalled();
    });

    it.each([
        ['missing Content-Length', undefined],
        ['misleading small Content-Length', '1'],
    ])('rejects an oversized streamed request with %s before multipart parsing', async (_label, contentLength) => {
        const request = makeRawMultipartRequest([3.5 * MiB], {
            targetLength: MAX_REQUEST_BYTES + 1,
            ...(contentLength === undefined ? {} : { contentLength }),
        });
        const formDataSpy = vi.spyOn(Request.prototype, 'formData');
        const response = await uploadRoute(request);
        expect(response.status).toBe(413);
        expect(formDataSpy).not.toHaveBeenCalled();
    });

    it('rejects an oversized declared Content-Length before reading or parsing the body', async () => {
        const request = makeRawMultipartRequest([1], { contentLength: String(MAX_REQUEST_BYTES + 1) });
        const formDataSpy = vi.spyOn(Request.prototype, 'formData');
        const response = await uploadRoute(request);
        expect(response.status).toBe(413);
        expect(formDataSpy).not.toHaveBeenCalled();
    });

    it('keeps the 413 response when request-body cancellation fails', async () => {
        const request = makeFormRequest([1], nextIp(), { 'content-length': String(MAX_REQUEST_BYTES + 1) });
        const cancelSpy = vi.spyOn(request.body!, 'cancel').mockRejectedValueOnce(new Error('injected cancellation failure'));
        const response = await uploadRoute(request);
        expect(response.status).toBe(413);
        expect(cancelSpy).toHaveBeenCalledOnce();
    });

    it('allows ten attempts per trusted Vercel IP per hour and returns 429 on the eleventh', async () => {
        const trustedIp = '203.0.113.70';
        for (let index = 0; index < 10; index += 1) {
            const request = makeFormRequest([1], trustedIp, {
                'x-forwarded-for': `192.0.2.${index + 1}`,
                'x-real-ip': `192.0.2.${index + 1}`,
            });
            expect((await uploadRoute(request)).status).toBe(200);
        }
        const limited = await uploadRoute(makeFormRequest([1], trustedIp, {
            'x-forwarded-for': '192.0.2.99',
            'x-real-ip': '192.0.2.99',
        }));
        expect(limited.status).toBe(429);
        expect(getVercelClientIp(makeFormRequest([1], trustedIp, { 'x-forwarded-for': '198.51.100.6' }))).toBe(trustedIp);
    });

    it('allows no more than ten concurrent attempts for a new IP', async () => {
        const trustedIp = '203.0.113.71';
        const responses = await Promise.all(Array.from({ length: 20 }, () =>
            uploadRoute(makeFormRequest([1], trustedIp))
        ));
        expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
        expect(responses.filter((response) => response.status === 429)).toHaveLength(10);
    });

    it('uses loopback for a local-development upload request without the Vercel header', async () => {
        await withNodeEnv('development', async () => {
            const request = new NextRequest('http://localhost/api/upload', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-forwarded-for': '198.51.100.81',
                    'x-real-ip': '198.51.100.82',
                },
            });
            expect(getVercelClientIp(request)).toBe('127.0.0.1');
            // A 415 shows the route passed IP resolution and reached content-type validation.
            expect((await uploadRoute(request)).status).toBe(415);
        });
    });

    it('uses a valid Vercel IP in local development', async () => {
        await withNodeEnv('development', () => {
            expect(getVercelClientIp(makeIpOnlyRequest({ 'x-vercel-forwarded-for': '203.0.113.82' }))).toBe('203.0.113.82');
        });
    });

    it('requires a Vercel IP in production when the header is absent', async () => {
        await withNodeEnv('production', () => {
            expect(getVercelClientIp(makeIpOnlyRequest({
                'x-forwarded-for': '198.51.100.83',
                'x-real-ip': '198.51.100.84',
            }))).toBeNull();
        });
    });

    it('uses a valid Vercel IP in production', async () => {
        await withNodeEnv('production', () => {
            expect(getVercelClientIp(makeIpOnlyRequest({ 'x-vercel-forwarded-for': '203.0.113.83' }))).toBe('203.0.113.83');
        });
    });

    it('fails closed when Vercel client IP is absent, ignoring other forwarding headers', async () => {
        const request = makeFormRequest([1], '203.0.113.81', {
            'x-vercel-forwarded-for': '',
            'x-forwarded-for': '198.51.100.81',
            'x-real-ip': '198.51.100.82',
        });
        const response = await uploadRoute(request);
        expect(response.status).toBe(503);
        expect(uploadMock.uploadFileToGridFS).not.toHaveBeenCalled();
    });

    it.each([
        ['malformed', 'not-an-ip'],
        ['comma-separated', '203.0.113.82, 198.51.100.82'],
    ])('rejects a %s Vercel client IP header in both environments', async (_label, headerValue) => {
        for (const nodeEnv of ['development', 'production']) {
            await withNodeEnv(nodeEnv, () => {
                const request = makeIpOnlyRequest({
                    'x-vercel-forwarded-for': headerValue,
                    'x-forwarded-for': '198.51.100.85',
                    'x-real-ip': '198.51.100.86',
                });
                expect(getVercelClientIp(request)).toBeNull();
            });
        }
        const response = await uploadRoute(makeFormRequest([1], '203.0.113.82', { 'x-vercel-forwarded-for': headerValue }));
        expect(response.status).toBe(503);
        expect(uploadMock.uploadFileToGridFS).not.toHaveBeenCalled();
    });

    it('returns 503 when the shared MongoDB limiter store fails', async () => {
        const ip = '203.0.113.90';
        await makeRateLimitRow(ip);
        vi.spyOn(OtpIpRateLimit, 'findOneAndUpdate').mockRejectedValueOnce(new Error('isolated test database operation failure'));
        const response = await uploadRoute(makeFormRequest([1], ip));
        expect(response.status).toBe(503);
        expect(uploadMock.uploadFileToGridFS).not.toHaveBeenCalled();
    });
});
