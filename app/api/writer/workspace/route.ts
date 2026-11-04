import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { getSession, hasWriterSession } from '@/lib/auth';
import { connectDB } from '@/lib/mongoose';
import { ACTIVE_WRITER_ORDER_STATUSES, getCompletedOrdersForWriter, getWriterCurrentAssignments } from '@/lib/db';
import UserModel from '@/lib/models/User';
import { expirePendingWriterAssignments } from '@/lib/assignment-expiration';

const COMPLETED_HISTORY_PAGE_SIZE = 10;
const MAX_HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGE = 10_000;
const MAX_HISTORY_SEARCH_LENGTH = 100;

function parsePositiveInteger(value: string | null, fallback: number, maximum: number): number | null {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
    return Math.min(parsed, maximum);
}

export async function GET(request: NextRequest) {
    try {
        const session = getSession(request);
        if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (!hasWriterSession(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        if (!mongoose.isValidObjectId(session.sub)) {
            return NextResponse.json({ error: 'Writer account not found' }, { status: 404 });
        }

        await connectDB();
        await expirePendingWriterAssignments();
        const writer = await UserModel.findOne({
            _id: session.sub,
            applicationStatus: 'approved',
            $or: [{ role: 'writer' }, { role: 'user' }],
        })
            .select('applicationStatus isAvailable')
            .lean();
        if (!writer) return NextResponse.json({ error: 'Approved writer access is required' }, { status: 403 });

        const { searchParams } = new URL(request.url);
        const completedPage = parsePositiveInteger(searchParams.get('completedPage'), 1, MAX_HISTORY_PAGE);
        const completedLimit = parsePositiveInteger(searchParams.get('completedLimit'), COMPLETED_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE);
        const completedSearch = searchParams.get('search')?.trim() || '';
        const completedSort = searchParams.get('sort') || 'newest';
        if (completedPage === null || completedLimit === null || completedSearch.length > MAX_HISTORY_SEARCH_LENGTH ||
            !['newest', 'oldest'].includes(completedSort)) {
            return NextResponse.json({ error: 'Invalid completed history query' }, { status: 400 });
        }

        const [currentAssignments, completedHistory] = await Promise.all([
            getWriterCurrentAssignments(session.sub),
            getCompletedOrdersForWriter(session.sub, {
                page: completedPage,
                limit: completedLimit,
                search: completedSearch,
                sort: completedSort as 'newest' | 'oldest',
            }),
        ]);
        const pendingAssignments = currentAssignments.filter((order) => order.assignmentStatus === 'pending_acceptance');
        const activeOrders = currentAssignments.filter((order) =>
            order.assignmentStatus === 'accepted' && ACTIVE_WRITER_ORDER_STATUSES.includes(order.orderStatus as typeof ACTIVE_WRITER_ORDER_STATUSES[number])
        );
        return NextResponse.json({
            isAvailable: writer.isAvailable === true,
            activeOrderCount: activeOrders.length,
            pendingAcceptanceCount: pendingAssignments.length,
            pendingAssignments,
            activeOrders,
            completedOrders: completedHistory.orders,
            completedTotalCount: completedHistory.totalCount,
            completedPage: completedHistory.page,
            completedLimit: completedHistory.limit,
            completedTotalPages: Math.max(1, Math.ceil(completedHistory.totalCount / completedHistory.limit)),
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Writer workspace lookup error:', error);
        return NextResponse.json({ error: 'Could not load writer workspace' }, { status: 500 });
    }
}
