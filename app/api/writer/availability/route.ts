import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getSession, hasWriterSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import UserModel from '@/lib/models/User';

export async function PUT(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (!hasWriterSession(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        if (!mongoose.isValidObjectId(session.sub)) {
            return NextResponse.json({ error: 'Writer account not found' }, { status: 404 });
        }

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
        }
        if (
            !body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).length !== 1 || typeof (body as { isAvailable?: unknown }).isAvailable !== 'boolean'
        ) {
            return NextResponse.json({ error: 'A boolean isAvailable value is required' }, { status: 400 });
        }

        await connectDB();
        const writerFilter = {
            _id: session.sub,
            applicationStatus: 'approved' as const,
            $or: [{ role: 'writer' as const }, { role: 'user' as const }],
        };
        const currentWriter = await UserModel.findOne(writerFilter)
            .select('applicationStatus').lean();
        if (!currentWriter) return NextResponse.json({ error: 'Writer account not found' }, { status: 404 });

        const writer = await UserModel.findOneAndUpdate(
            writerFilter,
            { $set: { isAvailable: (body as { isAvailable: boolean }).isAvailable } },
            { new: true }
        ).select('_id isAvailable').lean();

        if (!writer) return NextResponse.json({ error: 'Approved writer access is required' }, { status: 403 });
        return NextResponse.json(
            { isAvailable: writer.isAvailable === true },
            { headers: { 'Cache-Control': 'private, no-store' } }
        );
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer availability update error:', error);
        return NextResponse.json({ error: 'Could not update availability' }, { status: 500 });
    }
}
