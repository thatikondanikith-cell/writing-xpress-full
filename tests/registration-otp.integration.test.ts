import { createHmac, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { interpretRegistrationOtpResponse } from '@/lib/registration-otp-response';

const testState = vi.hoisted(() => ({
    capturedMessages: [] as Array<{ to: string | string[]; subject: string; text: string }>,
    hashFailures: 0,
    hashPasswordCalls: 0,
    emailFailures: 0,
    emailUnknownFailures: 0,
}));

vi.mock('nodemailer', () => ({
    default: {
        createTransport: () => ({
            sendMail: async (payload: { to: string | string[]; subject: string; text: string }) => {
                testState.capturedMessages.push({ to: payload.to, subject: payload.subject, text: payload.text });
                if (testState.emailFailures > 0) {
                    testState.emailFailures -= 1;
                    throw Object.assign(new Error('test-only injected recipient rejection'), { code: 'EENVELOPE', command: 'RCPT TO' });
                }
                if (testState.emailUnknownFailures > 0) {
                    testState.emailUnknownFailures -= 1;
                    throw Object.assign(new Error('test-only injected transport failure'), { code: 'ETIMEDOUT' });
                }
                return { accepted: [payload.to], rejected: [], messageId: 'test-email-accepted' };
            },
            close: () => {},
        }),
    },
}));

vi.mock('@/lib/auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/auth')>();
    return {
        ...actual,
        hashPassword: async (password: string) => {
            testState.hashPasswordCalls += 1;
            if (testState.hashFailures > 0) {
                testState.hashFailures -= 1;
                throw new Error('test-only injected password hashing failure');
            }
            return actual.hashPassword(password);
        },
    };
});

const TEST_OTP_SECRET = 'registration-otp-test-secret-only-32-bytes-minimum';
const TEST_JWT_SECRET = 'registration-otp-test-jwt-secret-not-for-deployment';
const TEST_EMAIL_SUFFIX = '@example.test';
const REGISTRATION_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mongoTestDataRoot = resolve(projectRoot, '.mongodb-test-data');
const mongoTestRunToken = process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN &&
    /^[0-9a-f-]{36}$/i.test(process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN)
    ? process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN
    : randomUUID();
process.env.WRITING_XPRESS_MONGODB_TEST_RUN_TOKEN = mongoTestRunToken;
const mongoTestRunDirectory = resolve(mongoTestDataRoot, `run-${process.pid}-${mongoTestRunToken}`);
const mongoTestDbPath = resolve(mongoTestRunDirectory, 'registration-otp');

type Role = 'user' | 'writer';
type Registration = { role: Role; name: string; email: string; password: string };

let mongod: MongoMemoryServer | undefined;
let mongoose: typeof import('mongoose').default;
let connectDB: typeof import('@/lib/mongoose').connectDB;
let UserModel: typeof import('@/lib/models/User').default;
let OtpChallenge: typeof import('@/lib/models/OtpChallenge').default;
let OtpSendLimit: typeof import('@/lib/models/OtpSendLimit').default;
let OtpIpRateLimit: typeof import('@/lib/models/OtpIpRateLimit').default;
let issueRoute: typeof import('@/app/api/registration/otp/route').POST;
let userSignup: typeof import('@/app/api/user/signup/route').POST;
let writerSignup: typeof import('@/app/api/writer/signup/route').POST;
let createToken: typeof import('@/lib/auth').createToken;
let hashPassword: typeof import('@/lib/auth').hashPassword;
let getOtpClientIp: typeof import('@/lib/otp-ip-rate-limit').getOtpClientIp;
let verifyOtp: typeof import('@/lib/otp').verifyOtp;

const runId = randomUUID().replaceAll('-', '');
const createdEmails = new Set<string>();
const createdSubjects = new Set<string>();
const usedIps = new Set<string>();
let emailSequence = 0;
let ipSequence = 0;
let mongoTestDbPathCreated = false;

async function createMongoTestDbPath() {
    await mkdir(mongoTestDataRoot, { recursive: true });
    await mkdir(mongoTestRunDirectory, { recursive: true });
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    assert(relativeDbPath === `run-${process.pid}-${mongoTestRunToken}${sep}registration-otp`, 'OTP MongoDB path must be this process suite directory');
    await mkdir(mongoTestDbPath);
    mongoTestDbPathCreated = true;
}

async function removeMongoTestDbPath() {
    if (!mongoTestDbPathCreated) return;
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    assert(relativeDbPath === `run-${process.pid}-${mongoTestRunToken}${sep}registration-otp`, 'refusing to remove an unexpected OTP MongoDB path');
    await rm(mongoTestDbPath, { recursive: true });
    mongoTestDbPathCreated = false;
}

function newEmail(label = 'account'): string {
    const email = `otp-${runId}-${label}-${++emailSequence}${TEST_EMAIL_SUFFIX}`;
    createdEmails.add(email);
    return email;
}

function newIp(): string {
    const ip = `198.51.100.${(ipSequence++ % 250) + 1}`;
    usedIps.add(ip);
    return ip;
}

function trackRegistrationId(registrationId: string, role: Role): void {
    createdSubjects.add(`${registrationId}:${role}`);
}

function makeRequest(path: string, body: unknown, ip = newIp(), extraHeaders: Record<string, string> = {}): NextRequest {
    usedIps.add(ip);
    return new NextRequest(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...extraHeaders },
        body: JSON.stringify(body),
    });
}

/** Simulates a trusted test ingress that overwrites client-supplied forwarding headers. */
function makeRequestThroughTestIngress(
    path: string,
    body: unknown,
    trustedIp: string,
    attackerHeaders: Record<string, string>
): NextRequest {
    const sanitizedHeaders = { ...attackerHeaders, 'x-real-ip': trustedIp, 'x-forwarded-for': trustedIp };
    return makeRequest(path, body, trustedIp, sanitizedHeaders);
}

function registration(role: Role, email = newEmail(role)): Registration {
    return { role, name: `${role} Test ${emailSequence}`, email, password: 'test-password-9723' };
}

async function requestOtp(input: Registration, registrationId?: string, ip = newIp()) {
    const response = await issueRoute(makeRequest('/api/registration/otp', {
        ...input,
        ...(registrationId ? { registrationId } : {}),
    }, ip));
    const body = await response.json() as { registrationId: string; message?: string; error?: string };
    if (body.registrationId) trackRegistrationId(body.registrationId, input.role);
    return { response, body };
}

function getCode(email: string): string {
    const message = [...testState.capturedMessages].reverse().find((item) =>
        (Array.isArray(item.to) ? item.to : [item.to]).includes(email)
    );
    if (!message) throw new Error('No mocked OTP email was captured for this test recipient');
    const code = message.text.match(/:\s*(\d{6})\b/)?.[1];
    if (!code) throw new Error('Mocked OTP email did not contain a six-digit code');
    return code;
}

async function completeRegistration(input: Registration, registrationId: string, code: string, ip = newIp()) {
    const path = input.role === 'user' ? '/api/user/signup' : '/api/writer/signup';
    const route = input.role === 'user' ? userSignup : writerSignup;
    return route(makeRequest(path, { ...input, registrationId, code }, ip));
}

function emailKey(email: string): string {
    return createHmac('sha256', TEST_OTP_SECRET).update(`otp-limit\0${email}`).digest('hex');
}

function ipKey(ip: string): string {
    return createHmac('sha256', TEST_OTP_SECRET).update(`otp-ip\0${ip}`).digest('hex');
}

async function cleanupTestRecords(): Promise<void> {
    if (!UserModel || !OtpChallenge || !OtpSendLimit || !OtpIpRateLimit) return;
    const emails = [...createdEmails];
    const subjects = [...createdSubjects];
    const ipKeys = [...usedIps].map(ipKey);
    if (emails.length) await UserModel.deleteMany({ email: { $in: emails } });
    if (subjects.length) await OtpChallenge.deleteMany({ subjectId: { $in: subjects } });
    if (emails.length) await OtpSendLimit.deleteMany({ emailKey: { $in: emails.map(emailKey) }, purpose: 'registration' });
    if (ipKeys.length) await OtpIpRateLimit.deleteMany({ ipKey: { $in: ipKeys } });
    createdEmails.clear();
    createdSubjects.clear();
    usedIps.clear();
}

function expectIndex(indexes: Array<{ key: Record<string, unknown>; unique?: boolean; expireAfterSeconds?: number }>, key: Record<string, number>, property: 'unique' | 'ttl'): void {
    const found = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(key));
    expect(found, `missing index ${JSON.stringify(key)}`).toBeDefined();
    if (property === 'unique') expect(found?.unique).toBe(true);
    else expect(found?.expireAfterSeconds).toBe(0);
}

beforeAll(async () => {
    if (process.env.WRITING_XPRESS_ISOLATED_TEST !== '1') {
        throw new Error('Use npm run test:registration-otp; direct Vitest execution is disabled.');
    }

    Reflect.set(process.env, 'NODE_ENV', 'test');
    process.env.OTP_HASH_SECRET = TEST_OTP_SECRET;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'mock-user@example.test';
    process.env.SMTP_PASS = 'mock-only-no-network-password';
    process.env.SMTP_FROM = 'WRITING-XPRESS Test <noreply@example.test>';
    delete process.env.ADMIN_NOTIFICATION_EMAIL;

    const databaseName = `writing_xpress_otp_test_${runId}`;
    await createMongoTestDbPath();
    mongod = await MongoMemoryServer.create({
        instance: {
            ip: '127.0.0.1',
            dbPath: mongoTestDbPath,
            dbName: databaseName,
            args: ['--setParameter', 'ttlMonitorSleepSecs=1'],
        },
    });
    const testMongoUri = mongod.getUri(databaseName);
    const parsedMongoUri = new URL(testMongoUri);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(parsedMongoUri.hostname), 'test MongoDB must bind to loopback');
    assert(parsedMongoUri.pathname.slice(1) === databaseName, 'test MongoDB database name must have the isolated test ID');
    process.env.MONGODB_URI = testMongoUri;

    // Application modules are imported only after MONGODB_URI points at this fresh in-memory instance.
    // Resolve the partial auth mock first so the signup route captures that exact hashPassword export.
    const authModule = await import('@/lib/auth');
    const [
        mongooseModule,
        mongooseConnectionModule,
        userModelModule,
        challengeModelModule,
        sendLimitModelModule,
        ipLimitModelModule,
        otpRouteModule,
        userSignupModule,
        writerSignupModule,
        ipHelperModule,
        otpModule,
    ] = await Promise.all([
        import('mongoose'),
        import('@/lib/mongoose'),
        import('@/lib/models/User'),
        import('@/lib/models/OtpChallenge'),
        import('@/lib/models/OtpSendLimit'),
        import('@/lib/models/OtpIpRateLimit'),
        import('@/app/api/registration/otp/route'),
        import('@/app/api/user/signup/route'),
        import('@/app/api/writer/signup/route'),
        import('@/lib/otp-ip-rate-limit'),
        import('@/lib/otp'),
    ]);
    mongoose = mongooseModule.default;
    connectDB = mongooseConnectionModule.connectDB;
    UserModel = userModelModule.default;
    OtpChallenge = challengeModelModule.default;
    OtpSendLimit = sendLimitModelModule.default;
    OtpIpRateLimit = ipLimitModelModule.default;
    issueRoute = otpRouteModule.POST;
    userSignup = userSignupModule.POST;
    writerSignup = writerSignupModule.POST;
    createToken = authModule.createToken;
    hashPassword = authModule.hashPassword;
    getOtpClientIp = ipHelperModule.getOtpClientIp;
    verifyOtp = otpModule.verifyOtp;

    await connectDB();
    await Promise.all([UserModel.init(), OtpChallenge.init(), OtpSendLimit.init(), OtpIpRateLimit.init()]);

    expectIndex(await UserModel.collection.indexes(), { email: 1 }, 'unique');
    expectIndex(await OtpChallenge.collection.indexes(), { subjectId: 1, email: 1, purpose: 1 }, 'unique');
    expectIndex(await OtpChallenge.collection.indexes(), { expiresAt: 1 }, 'ttl');
    expectIndex(await OtpSendLimit.collection.indexes(), { emailKey: 1, purpose: 1 }, 'unique');
    expectIndex(await OtpSendLimit.collection.indexes(), { expiresAt: 1 }, 'ttl');
    expectIndex(await OtpIpRateLimit.collection.indexes(), { ipKey: 1, action: 1 }, 'unique');
    expectIndex(await OtpIpRateLimit.collection.indexes(), { expiresAt: 1 }, 'ttl');
}, 60_000);

afterEach(async () => {
    await cleanupTestRecords();
    testState.capturedMessages.length = 0;
    testState.hashFailures = 0;
    testState.hashPasswordCalls = 0;
    testState.emailFailures = 0;
    testState.emailUnknownFailures = 0;
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'mock-user@example.test';
    process.env.SMTP_PASS = 'mock-only-no-network-password';
    process.env.SMTP_FROM = 'WRITING-XPRESS Test <noreply@example.test>';
    vi.restoreAllMocks();
});

afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) {
        const stopped = await mongod.stop();
        if (!stopped) throw new Error('Could not stop OTP MongoMemoryServer; leaving its dbPath intact');
    }
    await removeMongoTestDbPath();
    delete process.env.MONGODB_URI;
});

describe('isolated registration OTP routes', () => {
    it('returns generic eligibility wording only when SMTP accepts the message', async () => {
        const input = registration('user');

        const { response, body } = await requestOtp(input);

        expect(response.status).toBe(200);
        expect(body.message).toBe('If the request is eligible, you may receive a verification code.');
        expect(body.message).not.toMatch(/has been sent|was sent|delivered/i);
        expect(testState.capturedMessages).toHaveLength(1);
        expect(JSON.stringify(body)).not.toContain(getCode(input.email));
    });

    it('reports an SMTP recipient rejection and releases the failed email send reservation', async () => {
        testState.emailFailures = 1;
        const input = registration('user');

        const { response, body } = await requestOtp(input);

        expect(response.status).toBe(503);
        expect(body.error).toBe('We could not send a verification code right now. Please try again later.');
        expect(JSON.stringify(body)).not.toMatch(/test-only|Resend|\d{6}/i);
        const sendLimit = await OtpSendLimit.findOne({ emailKey: emailKey(input.email), purpose: 'registration' }).lean();
        expect(sendLimit?.sentAt).toHaveLength(0);
        expect(sendLimit?.pendingSends ?? []).toHaveLength(0);
        expect(sendLimit?.nextAllowedAt.getTime()).toBeLessThanOrEqual(Date.now());

        const retry = await requestOtp(input);
        expect(retry.response.status).toBe(200);
        expect(testState.capturedMessages).toHaveLength(2);
    });

    it('preserves a previously accepted OTP when a resend is rejected', async () => {
        const input = registration('user');
        const first = await requestOtp(input);
        const originalCode = getCode(input.email);
        await OtpSendLimit.updateOne(
            { emailKey: emailKey(input.email), purpose: 'registration' },
            { $set: { nextAllowedAt: new Date(Date.now() - 1_000) } }
        );
        testState.emailFailures = 1;

        const resend = await requestOtp(input, first.body.registrationId);

        expect(resend.response.status).toBe(503);
        expect(await verifyOtp({
            subjectId: `${first.body.registrationId}:user`, email: input.email, purpose: 'registration', code: originalCode,
        })).toBe(true);
    });

    it('keeps an ambiguous SMTP result counted and cooldown-protected', async () => {
        testState.emailUnknownFailures = 1;
        const input = registration('user');

        const { response } = await requestOtp(input);

        expect(response.status).toBe(503);
        const sendLimit = await OtpSendLimit.findOne({ emailKey: emailKey(input.email), purpose: 'registration' }).lean();
        expect(sendLimit?.sentAt).toHaveLength(1);
        expect(sendLimit?.pendingSends ?? []).toHaveLength(0);
        expect(sendLimit?.nextAllowedAt.getTime()).toBeGreaterThan(Date.now());
        expect((await requestOtp(input)).response.status).toBe(429);
    });

    it('reports missing SMTP configuration without reserving an email send', async () => {
        delete process.env.SMTP_PASS;
        const input = registration('user');

        const { response, body } = await requestOtp(input);

        expect(response.status).toBe(503);
        expect(body.error).toBe('Verification email service is temporarily unavailable. Please try again later.');
        expect(testState.capturedMessages).toHaveLength(0);
        expect(await OtpSendLimit.countDocuments({ emailKey: emailKey(input.email), purpose: 'registration' })).toBe(0);
    });

    it('shows cooldown and hourly-limit responses with retry information', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        const firstCount = testState.capturedMessages.length;

        const cooldown = await requestOtp(input, body.registrationId);
        expect(cooldown.response.status).toBe(429);
        expect(cooldown.body.error).toMatch(/wait/i);
        expect(Number(cooldown.response.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(testState.capturedMessages).toHaveLength(firstCount);

        const limitFilter = { emailKey: emailKey(input.email), purpose: 'registration' as const };
        const now = Date.now();
        await OtpSendLimit.updateOne(limitFilter, {
            $set: {
                nextAllowedAt: new Date(now - 1_000),
                sentAt: Array.from({ length: 5 }, (_, index) => new Date(now - index * 1_000)),
                pendingSends: [],
            },
        });
        const hourly = await requestOtp(input, body.registrationId);
        expect(hourly.response.status).toBe(429);
        expect(hourly.body.error).toMatch(/limit/i);
        expect(Number(hourly.response.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(testState.capturedMessages).toHaveLength(firstCount);
    });

    it('serializes concurrent requests for the same email with one accepted send', async () => {
        const input = registration('user');
        const results = await Promise.all([requestOtp(input), requestOtp(input)]);

        expect(results.map(({ response }) => response.status).sort()).toEqual([200, 429]);
        expect(testState.capturedMessages).toHaveLength(1);
        const sendLimit = await OtpSendLimit.findOne({ emailKey: emailKey(input.email), purpose: 'registration' }).lean();
        expect(sendLimit?.sentAt).toHaveLength(1);
        expect(sendLimit?.pendingSends ?? []).toHaveLength(0);
    });

    it('enforces the per-IP request limit without sending an eleventh email', async () => {
        const trustedIp = '203.0.113.77';
        for (let index = 0; index < 10; index += 1) {
            const input = registration('user');
            const response = await issueRoute(makeRequest('/api/registration/otp', input, trustedIp));
            expect(response.status).toBe(200);
        }
        expect(testState.capturedMessages).toHaveLength(10);
        const limited = await issueRoute(makeRequest('/api/registration/otp', registration('user'), trustedIp));
        expect(limited.status).toBe(429);
        expect((await limited.json()).error).toMatch(/Too many verification requests/);
        expect(testState.capturedMessages).toHaveLength(10);
    });

    it.each(['customer', 'writer'] as const)('frontend response handling for %s advances only on accepted API payloads', (role) => {
        const accepted = interpretRegistrationOtpResponse(200, {
            success: true,
            registrationId: randomUUID(),
            message: 'If the request is eligible, you may receive a verification code.',
        });
        expect(accepted.accepted, role).toBe(true);

        const failed = interpretRegistrationOtpResponse(503, { error: 'We could not send a verification code right now.' });
        expect(failed.accepted, role).toBe(false);
        expect(failed.message).toMatch(/could not send/i);

        const limited = interpretRegistrationOtpResponse(429, { error: 'Please wait before requesting another code.' });
        expect(limited.accepted, role).toBe(false);
        expect(limited.message).toMatch(/wait/i);
    });

    it('keeps account eligibility indistinguishable in the public success response', async () => {
        const existing = registration('user');
        await UserModel.create({
            name: 'Existing Account', email: existing.email, passwordHash: await hashPassword('existing-password'),
            createdAt: new Date().toISOString(), role: 'user',
        });
        const eligible = registration('user');

        const existingResponse = await requestOtp(existing);
        const eligibleResponse = await requestOtp(eligible);

        expect(existingResponse.response.status).toBe(200);
        expect(eligibleResponse.response.status).toBe(200);
        expect(existingResponse.body.message).toBe(eligibleResponse.body.message);
        expect(existingResponse.body.message).toBe('If the request is eligible, you may receive a verification code.');
    });

    it('verifies a customer OTP before creating a customer account', async () => {
        const input = registration('user');
        const { response: requested, body } = await requestOtp(input);
        expect(requested.status).toBe(200);
        const code = getCode(input.email);
        expect(JSON.stringify(body)).not.toContain(code);
        const completed = await completeRegistration(input, body.registrationId, code);
        expect(completed.status).toBe(200);
        expect((await UserModel.findOne({ email: input.email }))?.role).toBe('user');
        expect(completed.headers.get('set-cookie')).toContain('session=');
    });

    it('verifies an anonymous writer OTP and leaves the writer application pending', async () => {
        const input = registration('writer');
        const { body } = await requestOtp(input);
        const completed = await completeRegistration(input, body.registrationId, getCode(input.email));
        expect(completed.status).toBe(201);
        const writer = await UserModel.findOne({ email: input.email });
        expect(writer?.role).toBe('writer');
        expect(writer?.applicationStatus).toBe('pending');
    });

    it.each(['user', 'writer'] as const)('rejects a %s OTP at the other role route', async (issuedRole) => {
        const input = registration(issuedRole);
        const { body } = await requestOtp(input);
        const otherRole = issuedRole === 'user' ? 'writer' : 'user';
        const wrongRoleInput = { ...input, role: otherRole } as Registration;
        const wrongRoute = otherRole === 'user' ? userSignup : writerSignup;
        const rejected = await wrongRoute(makeRequest(`/api/${otherRole}/signup`, {
            ...wrongRoleInput, registrationId: body.registrationId, code: getCode(input.email),
        }));
        expect(rejected.status).toBe(400);
        expect(await UserModel.countDocuments({ email: input.email })).toBe(0);
    });

    it('rejects an incorrect code and caps attempts', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        const correctCode = getCode(input.email);
        const wrongCode = correctCode === '000000' ? '000001' : '000000';
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const response = await completeRegistration(input, body.registrationId, wrongCode);
            expect(response.status).toBe(400);
        }
        expect((await completeRegistration(input, body.registrationId, correctCode)).status).toBe(400);
        expect(await UserModel.countDocuments({ email: input.email })).toBe(0);
    });

    it('rejects an expired OTP independently of TTL cleanup', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        await OtpChallenge.updateOne(
            { subjectId: `${body.registrationId}:user`, email: input.email, purpose: 'registration' },
            { $set: { expiresAt: new Date(Date.now() - 1_000) } }
        );
        const response = await completeRegistration(input, body.registrationId, getCode(input.email));
        expect(response.status).toBe(400);
        expect(await UserModel.countDocuments({ email: input.email })).toBe(0);
    });

    it('prevents replay from creating another account', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        const code = getCode(input.email);
        expect((await completeRegistration(input, body.registrationId, code)).status).toBe(200);
        expect((await completeRegistration(input, body.registrationId, code)).status).toBe(400);
        expect(await UserModel.countDocuments({ email: input.email })).toBe(1);
    });

    it('leaves a valid OTP retryable when password hashing fails before consumption', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        const code = getCode(input.email);
        const hashCallsBefore = testState.hashPasswordCalls;
        testState.hashFailures = 1;
        const failedAttempt = await completeRegistration(input, body.registrationId, code);
        expect(testState.hashPasswordCalls).toBe(hashCallsBefore + 1);
        expect(testState.hashFailures).toBe(0);
        expect(failedAttempt.status).toBe(500);
        expect((await OtpChallenge.findOne({ subjectId: `${body.registrationId}:user` }))?.usedAt).toBeFalsy();
        const retry = await completeRegistration(input, body.registrationId, code);
        expect(retry.status).toBe(200);
        expect(testState.hashPasswordCalls).toBe(hashCallsBefore + 2);
    });

    it('resumes after user insertion failure with exactly the same details', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        const code = getCode(input.email);
        const createSpy = vi.spyOn(UserModel, 'create').mockRejectedValueOnce(new Error('test-only insertion failure'));
        expect((await completeRegistration(input, body.registrationId, code)).status).toBe(500);
        const challenge = await OtpChallenge.findOne({ subjectId: `${body.registrationId}:user` }).select('+registrationCompletion.detailsHash');
        expect(challenge?.usedAt).toBeInstanceOf(Date);
        expect(challenge?.registrationCompletion?.detailsHash).toMatch(/^[0-9a-f]{64}$/);
        expect(challenge?.registrationCompletion).not.toHaveProperty('password');
        expect(challenge?.registrationCompletion?.detailsHash).not.toContain(input.password);
        const claimedAt = challenge?.registrationCompletion?.claimedAt;
        if (!challenge || !claimedAt) throw new Error('registration completion marker was not stored');
        expect(challenge.expiresAt.getTime() - claimedAt.getTime()).toBe(REGISTRATION_RETRY_MS);
        expect(createSpy).toBeDefined();
        expect((await completeRegistration(input, body.registrationId, code)).status).toBe(200);
        expect(await UserModel.countDocuments({ email: input.email })).toBe(1);
    });

    it('rejects retry payload changes to name, email, password, role, or registration ID', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        const code = getCode(input.email);
        vi.spyOn(UserModel, 'create').mockRejectedValueOnce(new Error('test-only insertion failure'));
        expect((await completeRegistration(input, body.registrationId, code)).status).toBe(500);

        const variations: Array<{ input: Registration; registrationId: string }> = [
            { input: { ...input, name: `${input.name} Changed` }, registrationId: body.registrationId },
            { input: { ...input, email: newEmail('changed-email') }, registrationId: body.registrationId },
            { input: { ...input, password: `${input.password}x` }, registrationId: body.registrationId },
            { input: { ...input, role: 'writer' }, registrationId: body.registrationId },
            { input, registrationId: randomUUID() },
        ];
        for (const variation of variations) {
            const route = variation.input.role === 'user' ? userSignup : writerSignup;
            const response = await route(makeRequest(`/api/${variation.input.role}/signup`, {
                ...variation.input, registrationId: variation.registrationId, code,
            }));
            expect(response.status).toBe(400);
        }
        expect(await UserModel.countDocuments({ email: input.email })).toBe(0);
    });

    it('allows concurrent identical completion attempts to create at most one account', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        const code = getCode(input.email);
        const results = await Promise.all([
            completeRegistration(input, body.registrationId, code),
            completeRegistration(input, body.registrationId, code),
        ]);
        expect(results.filter((response) => response.status === 200)).toHaveLength(1);
        expect(await UserModel.countDocuments({ email: input.email })).toBe(1);
    });

    it('rejects duplicate email safely without changing the existing account', async () => {
        const input = registration('user');
        const existing = await UserModel.create({
            name: 'Existing Account', email: input.email, passwordHash: await hashPassword('existing-password'),
            createdAt: new Date().toISOString(), role: 'user',
        });
        const { body } = await requestOtp(input);
        const response = await completeRegistration(input, body.registrationId, getCode(input.email));
        expect(response.status).toBe(400);
        expect(await UserModel.countDocuments({ email: input.email })).toBe(1);
        expect((await UserModel.findById(existing._id))?.name).toBe('Existing Account');
    });

    it('preserves the signed-in customer writer-application path without OTP', async () => {
        const input = registration('user');
        const customer = await UserModel.create({
            name: input.name, email: input.email, passwordHash: await hashPassword(input.password),
            createdAt: new Date().toISOString(), role: 'user',
        });
        const sessionToken = createToken({ sub: customer._id.toString(), email: customer.email, role: 'user' });
        const response = await writerSignup(makeRequest('/api/writer/signup', {}, newIp(), { cookie: `session=${sessionToken}` }));
        expect(response.status).toBe(200);
        expect((await UserModel.findById(customer._id))?.applicationStatus).toBe('pending');
        expect(testState.capturedMessages).toHaveLength(0);
    });

    it('uses the sanitized test-ingress IP despite spoofed client forwarding headers', async () => {
        const trustedIp = '203.0.113.44';
        for (let index = 0; index < 10; index += 1) {
            const input = registration('user');
            const response = await issueRoute(makeRequestThroughTestIngress(
                '/api/registration/otp', input, trustedIp,
                { 'x-real-ip': `192.0.2.${index + 1}`, 'x-forwarded-for': `192.0.2.${index + 1}` }
            ));
            expect(response.status).toBe(200);
        }
        const nextInput = registration('user');
        const limited = await issueRoute(makeRequestThroughTestIngress(
            '/api/registration/otp', nextInput, trustedIp,
            { 'x-real-ip': '192.0.2.99', 'x-forwarded-for': '192.0.2.99' }
        ));
        expect(limited.status).toBe(429);

        const spoofedRequest = makeRequest('/api/registration/otp', {}, trustedIp, { 'x-forwarded-for': '192.0.2.111' });
        expect(getOtpClientIp(spoofedRequest)).toBe(trustedIp);
    });

    it('keeps a consumed completion until the seven-day retention deadline', async () => {
        const input = registration('user');
        const { body } = await requestOtp(input);
        const code = getCode(input.email);
        vi.spyOn(UserModel, 'create').mockRejectedValueOnce(new Error('test-only insertion failure'));
        expect((await completeRegistration(input, body.registrationId, code)).status).toBe(500);
        const challenge = await OtpChallenge.findOne({ subjectId: `${body.registrationId}:user` });
        const claimedAt = challenge?.registrationCompletion?.claimedAt;
        if (!challenge || !claimedAt) throw new Error('registration completion marker was not stored');
        expect(challenge.expiresAt.getTime() - claimedAt.getTime()).toBe(REGISTRATION_RETRY_MS);
        expect(await verifyOtp({ subjectId: `${body.registrationId}:user`, email: input.email, purpose: 'registration', code })).toBe(false);

        // Accelerate only this test record to prove the configured TTL index removes it.
        await OtpChallenge.updateOne({ _id: challenge._id }, { $set: { expiresAt: new Date(Date.now() - 2_000) } });
        const deadline = Date.now() + 10_000;
        let remaining = await OtpChallenge.findById(challenge._id);
        while (remaining && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            remaining = await OtpChallenge.findById(challenge._id);
        }
        expect(remaining).toBeNull();
    });
});
