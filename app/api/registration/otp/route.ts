import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { issueOtp } from '@/lib/otp';
import { consumeOtpIpAllowanceResult, getOtpClientIp } from '@/lib/otp-ip-rate-limit';

type RegistrationRole = 'user' | 'writer';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRegistration(body: Record<string, unknown>): {
    role: RegistrationRole;
    name: string;
    email: string;
    password: string;
} | null {
    if (body.role !== 'user' && body.role !== 'writer') return null;
    if (typeof body.name !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') return null;

    const role = body.role;
    const name = body.name.trim();
    const email = body.email.trim().toLowerCase();
    const password = body.password;
    if (!name || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6) return null;
    if (role === 'writer' && (
        name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) || password.length > 128
    )) return null;

    return { role, name, email, password };
}

function genericQueuedResponse(registrationId: string) {
    return NextResponse.json({
        success: true,
        registrationId,
        message: 'If the request is eligible, you may receive a verification code.',
    }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
    const ip = getOtpClientIp(request);
    if (!ip) return NextResponse.json({ error: 'Verification service temporarily unavailable' }, { status: 503 });
    const ipAllowance = await consumeOtpIpAllowanceResult(ip, 'request');
    if (ipAllowance === 'limited') {
        return NextResponse.json({ error: 'Too many verification requests. Please try again later.' }, { status: 429 });
    }
    if (ipAllowance === 'unavailable') {
        return NextResponse.json({ error: 'Verification service temporarily unavailable. Please try again later.' }, { status: 503 });
    }

    try {
        let body: unknown;
        try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid registration details' }, { status: 400 }); }
        if (!isRecord(body)) return NextResponse.json({ error: 'Invalid registration details' }, { status: 400 });

        const registration = validateRegistration(body);
        if (!registration) return NextResponse.json({ error: 'Invalid registration details' }, { status: 400 });

        const suppliedId = typeof body.registrationId === 'string' ? body.registrationId : '';
        const registrationId = suppliedId || randomUUID();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(registrationId)) {
            return NextResponse.json({ error: 'Invalid registration details' }, { status: 400 });
        }

        const result = await issueOtp({
            subjectId: `${registrationId}:${registration.role}`,
            email: registration.email,
            purpose: 'registration',
        });
        if (result.status === 'accepted') return genericQueuedResponse(registrationId);
        if (result.status === 'cooldown') {
            return NextResponse.json(
                { error: 'Please wait before requesting another verification code.' },
                { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds), 'Cache-Control': 'no-store' } }
            );
        }
        if (result.status === 'hourly_limit') {
            return NextResponse.json(
                { error: 'You have reached the verification code limit. Please try again later.' },
                { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds), 'Cache-Control': 'no-store' } }
            );
        }
        if (result.status === 'delivery_failed') {
            return NextResponse.json(
                { error: 'We could not send a verification code right now. Please try again later.' },
                { status: 503, headers: { 'Cache-Control': 'no-store' } }
            );
        }
        return NextResponse.json(
            { error: 'Verification email service is temporarily unavailable. Please try again later.' },
            { status: 503, headers: { 'Cache-Control': 'no-store' } }
        );
    } catch {
        return NextResponse.json({ error: 'Unable to process registration request' }, { status: 503 });
    }
}
