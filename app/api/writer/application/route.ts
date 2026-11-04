import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';

export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'writer' && session.role !== 'user') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        if (!mongoose.isValidObjectId(session.sub)) {
            return NextResponse.json({ error: 'Writer account not found' }, { status: 404 });
        }

        await connectDB();
        const writer = await UserModel.findOne({ _id: session.sub, role: session.role })
            .select('name email role applicationStatus applicationRejectionReason')
            .lean();

        if (!writer) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

        const status = writer.applicationStatus || (session.role === 'writer' ? 'pending' : 'not_applied');
        return NextResponse.json({
            name: writer.name,
            email: writer.email,
            role: writer.role,
            applicationStatus: status,
            ...(status === 'rejected' && writer.applicationRejectionReason
                ? { rejectionReason: writer.applicationRejectionReason }
                : {}),
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer application lookup error:', error);
        return NextResponse.json({ error: 'Failed to fetch writer application' }, { status: 500 });
    }
}
