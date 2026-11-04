import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';

export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        await connectDB();
        const applications = await UserModel.find({
            $or: [
                { role: 'writer' },
                { role: 'user', applicationStatus: { $in: ['pending', 'approved', 'rejected'] } },
            ],
        })
            .select('_id name email createdAt applicationSubmittedAt applicationStatus applicationReviewedAt applicationRejectionReason')
            .sort({ applicationSubmittedAt: -1, createdAt: -1 })
            .lean();

        return NextResponse.json(applications.map((application) => ({
            id: application._id.toString(),
            name: application.name,
            email: application.email,
            createdAt: application.applicationSubmittedAt || application.createdAt,
            applicationStatus: application.applicationStatus || 'pending',
            applicationReviewedAt: application.applicationReviewedAt,
            rejectionReason: application.applicationRejectionReason,
        })), { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer application list error:', error);
        return NextResponse.json({ error: 'Failed to fetch writer applications' }, { status: 500 });
    }
}
