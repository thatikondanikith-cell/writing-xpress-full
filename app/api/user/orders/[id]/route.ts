import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { createDeliveryDownloadToken, getSession } from '@/lib/auth';
import { getGridFSFileMetadata } from '@/lib/gridfs';
import { connectDB } from '@/lib/mongoose';
import OrderModel from '@/lib/models/Order';
import { getCustomerOrderOwnerFilter } from '@/lib/customer-order-ownership';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
    const session = getSession(request);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.role !== 'user' || !mongoose.isValidObjectId(session.sub)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    try {
        const { id } = await params;
        if (!/^WX-\d{8}-\d{4,}$/.test(id)) {
            return NextResponse.json({ error: 'Invalid order ID' }, { status: 400 });
        }

        await connectDB();
        const email = session.email.toLowerCase().trim();
        const order = await OrderModel.findOne({ orderId: id, ...getCustomerOrderOwnerFilter(email) })
            .select('orderId userName primaryPhone alternatePhone email address collegeName yearOfStudying branch uploadedFiles instructions priceAmount transactionId orderStatus createdDate deliveryFile physicalDeliveryStatus customerReview completedByWriterId completedAssignmentVersion')
            .lean();
        if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

        const uploadedFileNames = await Promise.all((order.uploadedFiles || []).map(async (fileId, index) => {
            try {
                const metadata = await getGridFSFileMetadata(fileId);
                return metadata.filename;
            } catch {
                return `Uploaded file ${index + 1}`;
            }
        }));

        const reviewSubmitted = Boolean(order.customerReview);
        const reviewEligible = order.orderStatus === 'Completed' && Boolean(
            order.deliveryFile && order.completedByWriterId && Number.isSafeInteger(order.completedAssignmentVersion)
        );
        const deliveryDownloadUrl = order.orderStatus === 'Completed' && order.deliveryFile
            ? `/api/files/${encodeURIComponent(order.deliveryFile)}?token=${encodeURIComponent(createDeliveryDownloadToken(session, order.orderId, order.deliveryFile))}`
            : null;

        return NextResponse.json({
            order: {
                orderId: order.orderId,
                userName: order.userName,
                email: order.email,
                primaryPhone: order.primaryPhone,
                alternatePhone: order.alternatePhone,
                address: order.address,
                collegeName: order.collegeName,
                yearOfStudying: order.yearOfStudying,
                branch: order.branch,
                uploadedFileNames,
                instructions: order.instructions,
                priceAmount: order.priceAmount,
                transactionId: order.transactionId,
                orderStatus: order.orderStatus,
                createdDate: order.createdDate,
                physicalDeliveryStatus: order.physicalDeliveryStatus,
                deliveryAvailable: Boolean(order.deliveryFile && deliveryDownloadUrl),
                deliveryDownloadUrl,
            },
            statusHistoryAvailable: false,
            review: {
                eligible: reviewEligible,
                submitted: reviewSubmitted,
                ...(reviewSubmitted ? {
                    rating: order.customerReview?.rating,
                    submittedAt: order.customerReview?.submittedAt,
                } : {}),
            },
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof Error && error.message.includes('JWT_SECRET')) {
            return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 });
        }
        console.error('Customer order detail error:', error);
        return NextResponse.json({ error: 'Could not load order details' }, { status: 500 });
    }
}
