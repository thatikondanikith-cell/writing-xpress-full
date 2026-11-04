import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import OtpChallenge from '@/lib/models/OtpChallenge';
import OtpSendLimit from '@/lib/models/OtpSendLimit';
import { connectDB } from '@/lib/mongoose';
import { hasOtpEmailConfiguration, sendOtpEmail, type OtpEmailPurpose } from '@/lib/email';

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_FAILED_ATTEMPTS = 5;
const REGISTRATION_RETRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type OtpIssueResult =
    | { status: 'accepted' }
    | { status: 'delivery_failed' }
    | { status: 'unavailable' }
    | { status: 'cooldown'; retryAfterSeconds: number }
    | { status: 'hourly_limit'; retryAfterSeconds: number };

type OtpSendReservation = {
    reservationId: string;
    reservedAt: Date;
    nextAllowedAt: Date;
};

type OtpReservationResult =
    | { status: 'reserved'; reservation: OtpSendReservation }
    | { status: 'cooldown'; retryAfterSeconds: number }
    | { status: 'hourly_limit'; retryAfterSeconds: number }
    | { status: 'unavailable' };

function getOtpSecret(): string {
    const secret = process.env.OTP_HASH_SECRET?.trim();
    if (!secret || secret.length < 32) {
        throw new Error('OTP_HASH_SECRET must contain at least 32 characters');
    }
    return secret;
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function createOtpHash(code: string, input: { subjectId: string; email: string; purpose: OtpEmailPurpose }): string {
    return createHmac('sha256', getOtpSecret())
        .update(`${input.purpose}\0${input.subjectId}\0${input.email}\0${code}`)
        .digest('hex');
}

function createEmailKey(email: string): string {
    return createHmac('sha256', getOtpSecret()).update(`otp-limit\0${email}`).digest('hex');
}

function isUniqueKeyError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
}

function recentEvents(sentAt: Date[], pendingSends: Array<{ reservedAt: Date }>, cutoff: Date): Date[] {
    return [
        ...sentAt.filter((date) => date > cutoff),
        ...pendingSends.map((pending) => pending.reservedAt).filter((date) => date > cutoff),
    ];
}

async function reserveEmailSend(
    scope: { emailKey: string; purpose: OtpEmailPurpose },
    now: Date
): Promise<OtpReservationResult> {
    const reservationId = randomUUID();
    const nextAllowedAt = new Date(now.getTime() + RESEND_COOLDOWN_MS);
    const cutoff = new Date(now.getTime() - SEND_WINDOW_MS);
    const reservation = { reservationId, reservedAt: now };

    try {
        await OtpSendLimit.create({
            ...scope,
            sentAt: [],
            pendingSends: [reservation],
            nextAllowedAt,
            expiresAt: new Date(now.getTime() + SEND_WINDOW_MS),
        });
        return { status: 'reserved', reservation: { ...reservation, nextAllowedAt } };
    } catch (error) {
        if (!isUniqueKeyError(error)) throw error;
    }

    const updated = await OtpSendLimit.findOneAndUpdate(
        {
            ...scope,
            nextAllowedAt: { $lte: now },
            $expr: {
                $lt: [
                    { $add: [
                        { $size: { $filter: {
                            input: '$sentAt',
                            as: 'sent',
                            cond: { $gt: ['$$sent', cutoff] },
                        } } },
                        { $size: { $filter: {
                            input: { $ifNull: ['$pendingSends', []] },
                            as: 'pending',
                            cond: { $gt: ['$$pending.reservedAt', cutoff] },
                        } } },
                    ] },
                    MAX_SENDS_PER_WINDOW,
                ],
            },
        },
        [{
            $set: {
                sentAt: { $filter: {
                    input: '$sentAt',
                    as: 'sent',
                    cond: { $gt: ['$$sent', cutoff] },
                } },
                pendingSends: { $concatArrays: [
                    { $filter: {
                        input: { $ifNull: ['$pendingSends', []] },
                        as: 'pending',
                        cond: { $gt: ['$$pending.reservedAt', cutoff] },
                    } },
                    [{ reservationId, reservedAt: now }],
                ] },
                nextAllowedAt,
                expiresAt: new Date(now.getTime() + SEND_WINDOW_MS),
            },
        }],
        { new: true, updatePipeline: true }
    );
    if (updated) return { status: 'reserved', reservation: { ...reservation, nextAllowedAt } };

    const current = await OtpSendLimit.findOne(scope).select('sentAt pendingSends nextAllowedAt').lean();
    if (!current) return { status: 'unavailable' };
    if (current.nextAllowedAt > now) {
        return { status: 'cooldown', retryAfterSeconds: Math.max(1, Math.ceil((current.nextAllowedAt.getTime() - now.getTime()) / 1000)) };
    }
    const events = recentEvents(current.sentAt ?? [], current.pendingSends ?? [], cutoff);
    if (events.length >= MAX_SENDS_PER_WINDOW) {
        const nextAvailableAt = Math.min(...events.map((date) => date.getTime())) + SEND_WINDOW_MS;
        return { status: 'hourly_limit', retryAfterSeconds: Math.max(1, Math.ceil((nextAvailableAt - now.getTime()) / 1000)) };
    }
    return { status: 'unavailable' };
}

async function finalizeEmailReservation(
    scope: { emailKey: string; purpose: OtpEmailPurpose },
    reservation: OtpSendReservation,
    accepted: boolean
): Promise<void> {
    if (accepted) {
        const result = await OtpSendLimit.updateOne(
            { ...scope, 'pendingSends.reservationId': reservation.reservationId },
            {
                $pull: { pendingSends: { reservationId: reservation.reservationId } },
                $push: { sentAt: reservation.reservedAt },
                $set: { expiresAt: new Date(reservation.reservedAt.getTime() + SEND_WINDOW_MS) },
            }
        );
        if (result.modifiedCount !== 1) throw new Error('OTP send reservation could not be finalized');
        return;
    }

    // Only roll back this attempt's cooldown if no later request has reserved a slot.
    await OtpSendLimit.updateOne(
        {
            ...scope,
            'pendingSends.reservationId': reservation.reservationId,
            nextAllowedAt: reservation.nextAllowedAt,
        },
        [{
            $set: {
                pendingSends: { $filter: {
                    input: { $ifNull: ['$pendingSends', []] },
                    as: 'pending',
                    cond: { $ne: ['$$pending.reservationId', reservation.reservationId] },
                } },
                nextAllowedAt: reservation.reservedAt,
            },
        }],
        { updatePipeline: true }
    );
    // A later request may already own the cooldown; still release this failed reservation.
    await OtpSendLimit.updateOne(
        { ...scope, 'pendingSends.reservationId': reservation.reservationId },
        { $pull: { pendingSends: { reservationId: reservation.reservationId } } }
    );
}

/**
 * Issues a purpose-bound six-digit OTP. subjectId identifies either an existing
 * account or a pending registration record; it does not create a session.
 */
export async function issueOtp(input: {
    subjectId: string;
    email: string;
    purpose: OtpEmailPurpose;
}): Promise<OtpIssueResult> {
    const subjectId = input.subjectId.trim();
    const email = normalizeEmail(input.email);
    if (!subjectId || subjectId.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 'unavailable' };
    const secret = getOtpSecret();
    if (!hasOtpEmailConfiguration()) return { status: 'unavailable' };

    await connectDB();
    const now = new Date();
    const emailKey = createEmailKey(email);
    const limitScope = { emailKey, purpose: input.purpose };
    const reservationResult = await reserveEmailSend(limitScope, now);
    if (reservationResult.status !== 'reserved') {
        if (reservationResult.status === 'cooldown' || reservationResult.status === 'hourly_limit') return reservationResult;
        return { status: 'unavailable' };
    }
    const { reservation } = reservationResult;

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    const resendAvailableAt = new Date(now.getTime() + RESEND_COOLDOWN_MS);
    const otpHash = createHmac('sha256', secret)
        .update(`${input.purpose}\0${subjectId}\0${email}\0${code}`)
        .digest('hex');
    const challengeScope = { subjectId, email, purpose: input.purpose };
    let previousChallenge: {
        otpHash: string;
        expiresAt: Date;
        failedAttempts: number;
        resendAvailableAt: Date;
        usedAt?: Date | null;
        createdAt: Date;
    } | null = null;

    try {
        previousChallenge = await OtpChallenge.findOne(challengeScope).select('+otpHash').lean();
        await OtpChallenge.findOneAndUpdate(
            { subjectId, email, purpose: input.purpose, registrationCompletion: { $exists: false } },
            {
                $set: { otpHash, expiresAt, failedAttempts: 0, resendAvailableAt, usedAt: null, createdAt: now },
            },
            { upsert: true, new: true, runValidators: true }
        );
    } catch (error) {
        // A completed registration challenge must not be overwritten by a resend.
        await finalizeEmailReservation(limitScope, reservation, false);
        if (isUniqueKeyError(error)) return { status: 'unavailable' };
        throw error;
    }

    const result = await sendOtpEmail({
        to: email,
        purpose: input.purpose,
        code,
        idempotencyKey: `otp/${input.purpose}/${randomUUID()}`,
    });
    if (result === 'accepted') {
        await finalizeEmailReservation(limitScope, reservation, true);
        return { status: 'accepted' };
    }

    if (result === 'rejected' || result === 'unavailable') {
        const failedChallengeFilter = {
            subjectId, email, purpose: input.purpose, otpHash, usedAt: null,
            registrationCompletion: { $exists: false },
        };
        if (previousChallenge) {
            await OtpChallenge.updateOne(failedChallengeFilter, {
                $set: {
                    otpHash: previousChallenge.otpHash,
                    expiresAt: previousChallenge.expiresAt,
                    failedAttempts: previousChallenge.failedAttempts,
                    resendAvailableAt: previousChallenge.resendAvailableAt,
                    usedAt: previousChallenge.usedAt ?? null,
                    createdAt: previousChallenge.createdAt,
                },
            });
        } else {
            await OtpChallenge.deleteOne(failedChallengeFilter);
        }
        await finalizeEmailReservation(limitScope, reservation, false);
    } else {
        // A transport failure may happen after provider acceptance; count it conservatively.
        await finalizeEmailReservation(limitScope, reservation, true);
    }
    // Never return provider details, OTP values, or destination addresses.
    return result === 'unavailable' ? { status: 'unavailable' } : { status: 'delivery_failed' };
}

/** Atomically consumes a valid challenge; concurrent reuse can only succeed once. */
export async function verifyOtp(input: {
    subjectId: string;
    email: string;
    purpose: OtpEmailPurpose;
    code: string;
}): Promise<boolean> {
    const subjectId = input.subjectId.trim();
    const email = normalizeEmail(input.email);
    if (!subjectId || !/^\d{6}$/.test(input.code)) return false;

    await connectDB();
    const now = new Date();
    const scope = { subjectId, email, purpose: input.purpose };
    const otpHash = createOtpHash(input.code, { subjectId, email, purpose: input.purpose });
    const consumed = await OtpChallenge.findOneAndUpdate(
        { ...scope, otpHash, expiresAt: { $gt: now }, usedAt: null, failedAttempts: { $lt: MAX_FAILED_ATTEMPTS } },
        { $set: { usedAt: now } },
        { new: true }
    ).select('_id');
    if (consumed) return true;

    // Incorrect attempts are incremented server-side and atomically capped.
    await OtpChallenge.updateOne(
        { ...scope, expiresAt: { $gt: now }, usedAt: null, failedAttempts: { $lt: MAX_FAILED_ATTEMPTS }, otpHash: { $ne: otpHash } },
        { $inc: { failedAttempts: 1 } }
    );
    return false;
}

export type RegistrationOtpClaim = 'claimed' | 'retry' | 'invalid';

/** Consumes a registration OTP once and records immutable completion details for retry. */
export async function claimRegistrationOtp(input: {
    subjectId: string;
    email: string;
    role: 'user' | 'writer';
    name: string;
    password: string;
    code: string;
}): Promise<RegistrationOtpClaim> {
    const subjectId = input.subjectId.trim();
    const email = normalizeEmail(input.email);
    if (!subjectId || !/^\d{6}$/.test(input.code)) return 'invalid';

    await connectDB();
    const secret = getOtpSecret();
    const now = new Date();
    const scope = { subjectId, email, purpose: 'registration' as const };
    const otpHash = createOtpHash(input.code, { subjectId, email, purpose: 'registration' });
    const detailsHash = createHmac('sha256', secret)
        .update(JSON.stringify([subjectId, input.role, email, input.name, input.password]))
        .digest('hex');
    const retryUntil = new Date(now.getTime() + REGISTRATION_RETRY_TTL_MS);

    const claimed = await OtpChallenge.findOneAndUpdate(
        {
            ...scope,
            otpHash,
            expiresAt: { $gt: now },
            usedAt: null,
            failedAttempts: { $lt: MAX_FAILED_ATTEMPTS },
            registrationCompletion: { $exists: false },
        },
        {
            $set: {
                usedAt: now,
                expiresAt: retryUntil,
                registrationCompletion: {
                    role: input.role,
                    name: input.name,
                    detailsHash,
                    claimedAt: now,
                },
            },
        },
        { new: true, runValidators: true }
    ).select('_id');
    if (claimed) return 'claimed';

    // A consumed challenge can resume only the exact same registration payload.
    const priorClaim = await OtpChallenge.findOne({
        ...scope,
        otpHash,
        usedAt: { $ne: null },
        expiresAt: { $gt: now },
        'registrationCompletion.role': input.role,
        'registrationCompletion.name': input.name,
    }).select('+registrationCompletion.detailsHash');
    const storedDetailsHash = priorClaim?.registrationCompletion?.detailsHash;
    if (storedDetailsHash && /^[0-9a-f]{64}$/i.test(storedDetailsHash) &&
        timingSafeEqual(Buffer.from(storedDetailsHash, 'hex'), Buffer.from(detailsHash, 'hex'))) {
        return 'retry';
    }

    // Wrong codes only count against a live, unused challenge.
    await OtpChallenge.updateOne(
        { ...scope, expiresAt: { $gt: now }, usedAt: null, failedAttempts: { $lt: MAX_FAILED_ATTEMPTS }, otpHash: { $ne: otpHash } },
        { $inc: { failedAttempts: 1 } }
    );
    return 'invalid';
}

