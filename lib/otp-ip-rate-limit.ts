import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextRequest } from 'next/server';
import OtpIpRateLimit, { type OtpIpAction } from '@/lib/models/OtpIpRateLimit';
import { connectDB } from '@/lib/mongoose';

const WINDOW_MS = 60 * 60 * 1000;
const LIMITS: Record<OtpIpAction, number> = { request: 10, verify: 30, upload: 10 };

function getSecret(): string {
    const secret = process.env.OTP_HASH_SECRET?.trim();
    if (!secret || secret.length < 32) throw new Error('OTP_HASH_SECRET must contain at least 32 characters');
    return secret;
}

/** Resolve only proxy-provided addresses; production proxies must overwrite/sanitize these headers. */
export function getOtpClientIp(request: NextRequest): string | null {
    const realIp = request.headers.get('x-real-ip')?.trim();
    if (realIp && isIP(realIp)) return realIp;

    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
        const candidates = forwarded.split(',').map((value) => value.trim()).reverse();
        const trustedProxyAddress = candidates.find((value) => isIP(value));
        if (trustedProxyAddress) return trustedProxyAddress;
    }

    return process.env.NODE_ENV === 'development' ? '127.0.0.1' : null;
}

/** Read Vercel's platform IP header; use loopback only in local development when it is absent. */
export function getVercelClientIp(request: NextRequest): string | null {
    const header = request.headers.get('x-vercel-forwarded-for');
    if (header === null) return process.env.NODE_ENV === 'development' ? '127.0.0.1' : null;

    const value = header.trim();
    if (!value || value.includes(',')) return null;
    return isIP(value) ? value : null;
}

export type OtpIpAllowanceResult = 'allowed' | 'limited' | 'unavailable';

/** Atomically records an IP event in a persistent rolling one-hour window. */
async function consumeIpAllowance(ip: string, action: OtpIpAction): Promise<OtpIpAllowanceResult> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - WINDOW_MS);
    const namespace = action === 'upload' ? 'upload-ip' : 'otp-ip';
    const ipKey = createHmac('sha256', getSecret()).update(`${namespace}\0${ip}`).digest('hex');
    const scope = { ipKey, action };

    try {
        await connectDB();
        try {
            await OtpIpRateLimit.create({ ...scope, events: [now], expiresAt: new Date(now.getTime() + WINDOW_MS) });
            return 'allowed';
        } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
        }

        const updated = await OtpIpRateLimit.findOneAndUpdate(
            {
                ...scope,
                $expr: {
                    $lt: [
                        { $size: { $filter: {
                            input: '$events',
                            as: 'event',
                            cond: { $gt: ['$$event', cutoff] },
                        } } },
                        LIMITS[action],
                    ],
                },
            },
            [{
                $set: {
                    events: { $concatArrays: [
                        { $filter: {
                            input: '$events',
                            as: 'event',
                            cond: { $gt: ['$$event', cutoff] },
                        } },
                        [now],
                    ] },
                    expiresAt: new Date(now.getTime() + WINDOW_MS),
                },
            }],
            { new: true, updatePipeline: true }
        );
        return updated ? 'allowed' : 'limited';
    } catch {
        return 'unavailable';
    }
}

/** Preserve the OTP callers' existing boolean behavior and action limits. */
export async function consumeOtpIpAllowance(ip: string, action: Exclude<OtpIpAction, 'upload'>): Promise<boolean> {
    return (await consumeIpAllowance(ip, action)) === 'allowed';
}

export function consumeOtpIpAllowanceResult(ip: string, action: Exclude<OtpIpAction, 'upload'>): Promise<OtpIpAllowanceResult> {
    return consumeIpAllowance(ip, action);
}

/** Upload throttling distinguishes quota exhaustion from limiter-store failure. */
export function consumeUploadIpAllowance(ip: string): Promise<OtpIpAllowanceResult> {
    return consumeIpAllowance(ip, 'upload').catch(() => 'unavailable');
}
