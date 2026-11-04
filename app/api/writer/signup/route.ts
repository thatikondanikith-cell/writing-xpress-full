import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';
import { createToken, getSession, hashPassword, setSessionCookie } from '@/lib/auth';
import { getAdminNotificationEmail, sendWorkflowEmail } from '@/lib/email';
import { emailPaths } from '@/lib/email-template';
import { claimRegistrationOtp } from '@/lib/otp';
import { consumeOtpIpAllowance, getOtpClientIp } from '@/lib/otp-ip-rate-limit';

export async function POST(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) {
            const ip = getOtpClientIp(request);
            if (!ip) return NextResponse.json({ error: 'Unable to complete registration' }, { status: 503 });
            if (!await consumeOtpIpAllowance(ip, 'verify')) {
                return NextResponse.json({ error: 'Too many verification attempts. Please try again later.' }, { status: 429 });
            }
        }

        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (session?.role === 'user') {
            await connectDB();
            const customer = await UserModel.findOne({ _id: session.sub, role: 'user', email: session.email })
                .select('_id name email applicationStatus').lean();
            if (!customer) return NextResponse.json({ error: 'Customer account not found' }, { status: 404 });

            if (customer.applicationStatus === 'approved') {
                return NextResponse.json({ error: 'Your writer application is already approved' }, { status: 409 });
            }

            const now = new Date().toISOString();
            const applicant = await UserModel.findOneAndUpdate(
                { _id: customer._id, role: 'user', applicationStatus: { $ne: 'pending' } },
                {
                    $set: { applicationStatus: 'pending', applicationSubmittedAt: now },
                    $unset: { applicationReviewedAt: 1, applicationReviewedBy: 1, applicationRejectionReason: 1 },
                },
                { new: true, runValidators: true }
            ).select('_id name email applicationStatus').lean();

            if (!applicant) {
                return NextResponse.json({ error: 'A writer application is already pending' }, { status: 409 });
            }

            await sendWorkflowEmail({
                event: 'writer_application_submitted',
                to: getAdminNotificationEmail(),
                subject: 'A WRITING-XPRESS writer application is ready for review',
                text: `A new writer application was submitted and is awaiting an administrator decision.\n\nApplicant: ${applicant.name}\nEmail: ${applicant.email}\nApplication ID: ${applicant._id.toString()}\n\nOpen the application list to review the applicant's details and record a decision.`,
                action: { label: 'Review Applications', path: emailPaths(applicant._id.toString()).adminApplications },
                idempotencyKey: `writer-application-submitted/${applicant._id.toString()}/${now}`,
            });

            return NextResponse.json({
                success: true,
                user: { name: applicant.name, email: applicant.email, role: 'user', applicationStatus: 'pending' },
            }, { status: 200 });
        }

        if (session) {
            return NextResponse.json({ error: 'Sign out before submitting a new writer registration' }, { status: 403 });
        }

        if (!name || !email || !password) {
            return NextResponse.json({ error: 'Name, email, and password are required' }, { status: 400 });
        }
        if (name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
            return NextResponse.json({ error: 'Name is invalid' }, { status: 400 });
        }
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
        }
        if (password.length < 6 || password.length > 128) {
            return NextResponse.json({ error: 'Password must be between 6 and 128 characters' }, { status: 400 });
        }

        const code = typeof body.code === 'string' ? body.code : '';
        const registrationId = typeof body.registrationId === 'string' ? body.registrationId : '';
        if (!/^\d{6}$/.test(code) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(registrationId)) {
            return NextResponse.json({ error: 'Invalid registration details or verification code' }, { status: 400 });
        }

        const passwordHash = await hashPassword(password);
        await connectDB();
        const claim = await claimRegistrationOtp({
            subjectId: `${registrationId}:writer`, email, role: 'writer', name, password, code,
        });
        if (claim === 'invalid') {
            return NextResponse.json({ error: 'Unable to complete registration. Check your details and verification code.' }, { status: 400 });
        }

        const user = await UserModel.create({
            name,
            email,
            passwordHash,
            createdAt: new Date().toISOString(),
            role: 'writer',
            applicationStatus: 'pending',
            applicationSubmittedAt: new Date().toISOString(),
        });

        await sendWorkflowEmail({
            event: 'writer_application_submitted',
            to: getAdminNotificationEmail(),
            subject: 'A WRITING-XPRESS writer application is ready for review',
            text: `A new writer application was submitted and is awaiting an administrator decision.\n\nApplicant: ${user.name}\nEmail: ${user.email}\nApplication ID: ${user._id.toString()}\n\nOpen the application list to review the applicant's details and record a decision.`,
            action: { label: 'Review Applications', path: emailPaths(user._id.toString()).adminApplications },
            idempotencyKey: `writer-application-submitted/${user._id.toString()}`,
        });

        const token = createToken({
            sub: user._id.toString(),
            email: user.email,
            role: 'writer',
        });
        const response = NextResponse.json({
            success: true,
            user: {
                name: user.name,
                email: user.email,
                role: 'writer',
                applicationStatus: 'pending',
            },
        }, { status: 201 });
        setSessionCookie(response, token);
        return response;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
            return NextResponse.json({ error: 'Unable to complete registration. Check your details and verification code.' }, { status: 400 });
        }
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer signup error');
        return NextResponse.json({ error: 'Failed to submit writer application' }, { status: 500 });
    }
}
