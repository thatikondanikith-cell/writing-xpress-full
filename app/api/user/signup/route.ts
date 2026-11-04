import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';
import { createToken, hashPassword, setSessionCookie } from '@/lib/auth';
import { claimRegistrationOtp } from '@/lib/otp';
import { consumeOtpIpAllowance, getOtpClientIp } from '@/lib/otp-ip-rate-limit';

export async function POST(request: NextRequest) {
    try {
        const ip = getOtpClientIp(request);
        if (!ip) return NextResponse.json({ error: 'Unable to complete registration' }, { status: 503 });
        if (!await consumeOtpIpAllowance(ip, 'verify')) {
            return NextResponse.json({ error: 'Too many verification attempts. Please try again later.' }, { status: 429 });
        }

        let body: unknown;
        try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid registration details' }, { status: 400 }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: 'Invalid registration details' }, { status: 400 });
        }

        const data = body as Record<string, unknown>;
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const password = typeof data.password === 'string' ? data.password : '';
        const code = typeof data.code === 'string' ? data.code : '';
        const registrationId = typeof data.registrationId === 'string' ? data.registrationId : '';
        if (!name || !email || !password || password.length < 6 || email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(registrationId) ||
            !/^\d{6}$/.test(code)) {
            return NextResponse.json({ error: 'Invalid registration details or verification code' }, { status: 400 });
        }

        const passwordHash = await hashPassword(password);
        await connectDB();
        const claim = await claimRegistrationOtp({
            subjectId: `${registrationId}:user`, email, role: 'user', name, password, code,
        });
        if (claim === 'invalid') {
            return NextResponse.json({ error: 'Unable to complete registration. Check your details and verification code.' }, { status: 400 });
        }

        const user = await UserModel.create({
            name: name.trim(),
            email,
            passwordHash,
            createdAt: new Date().toISOString(),
        });

        const token = createToken({
            sub: user._id.toString(),
            email: user.email,
            role: 'user',
        });
        const response = NextResponse.json({
            success: true,
            user: {
                name: user.name,
                email: user.email,
            },
        });
        setSessionCookie(response, token);
        return response;

    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
            return NextResponse.json({ error: 'Unable to complete registration. Check your details and verification code.' }, { status: 400 });
        }
        console.error('Signup error');
        return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
    }
}
