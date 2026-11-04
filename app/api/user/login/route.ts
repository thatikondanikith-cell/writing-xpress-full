import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';
import { createToken, setSessionCookie, verifyPassword } from '@/lib/auth';
export async function POST(request: NextRequest) {
    try {
        await connectDB();

        const { email, password } = await request.json();

        if (!email || !password) {
            return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
        }

        const user = await UserModel.findOne({ email: email.toLowerCase().trim() });
        if (!user) {
            return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
        }

        if (!(await verifyPassword(password, user.passwordHash))) {
            return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
        }

        const role = user.role === 'writer' ? 'writer' : 'user';
        const writerAccess = role === 'writer' || user.applicationStatus === 'approved';
        const token = createToken({
            sub: user._id.toString(),
            email: user.email,
            role,
            ...(role === 'user' && writerAccess ? { writerAccess: true } : {}),
        });
        const response = NextResponse.json({
            success: true,
            user: {
                name: user.name,
                email: user.email,
                role,
                ...(user.applicationStatus ? {
                    applicationStatus: user.applicationStatus || 'pending',
                } : {}),
                writerAccess,
            },
        });
        setSessionCookie(response, token);
        return response;

    } catch (error) {
        console.error('Login error:', error);
        return NextResponse.json({ error: 'Login failed' }, { status: 500 });
    }
}
