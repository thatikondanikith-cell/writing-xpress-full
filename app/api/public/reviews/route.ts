import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';

export const dynamic = 'force-dynamic';

/** Public projection of reviews attached to completed, delivered customer orders. */
export async function GET() {
    try {
        await connectDB();
        const orders = await OrderModel.find({
            orderStatus: 'Completed',
            deliveryFile: { $exists: true, $nin: [null, ''] },
            completedByWriterId: { $exists: true, $nin: [null, ''] },
            customerReview: { $exists: true },
            'customerReview.rating': { $gte: 1, $lte: 5 },
            'customerReview.displayName': { $type: 'string', $ne: '' },
            'customerReview.text': { $type: 'string', $ne: '' },
            'customerReview.submittedAt': { $type: 'string' },
        })
            .select('customerReview.rating customerReview.displayName customerReview.text customerReview.submittedAt')
            .sort({ 'customerReview.submittedAt': -1 })
            .limit(24)
            .lean();

        const reviews = orders.flatMap((order) => {
            const review = order.customerReview;
            if (!review || !Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5 ||
                typeof review.displayName !== 'string' || typeof review.text !== 'string') return [];
            const displayName = review.displayName.trim().slice(0, 60);
            const text = review.text.trim().slice(0, 1000);
            if (displayName.length < 2 || displayName.includes('@') || text.length < 10) return [];
            return [{ displayName, rating: review.rating, text, verifiedCustomer: true as const }];
        });

        return NextResponse.json({ reviews }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        console.error('Public customer reviews error:', error);
        return NextResponse.json({ error: 'Could not load customer stories' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
}
