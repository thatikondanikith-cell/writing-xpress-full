'use client';

import BrandMark from '@/components/BrandMark';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type CustomerOrderDetails = {
    order: {
        orderId: string;
        userName: string;
        email: string;
        primaryPhone: string;
        alternatePhone?: string;
        address?: string;
        collegeName: string;
        yearOfStudying: string;
        branch: string;
        uploadedFileNames: string[];
        instructions: string;
        priceAmount?: number;
        transactionId?: string;
        orderStatus: string;
        createdDate: string;
        physicalDeliveryStatus?: string;
        deliveryAvailable: boolean;
        deliveryDownloadUrl: string | null;
    };
    statusHistoryAvailable: boolean;
    review: {
        eligible: boolean;
        submitted: boolean;
        rating?: number;
        submittedAt?: string;
    };
};

export default function CustomerOrderDetailsPage({ params }: { params: Promise<{ id: string }> }) {
    const router = useRouter();
    const [orderId, setOrderId] = useState('');
    const [details, setDetails] = useState<CustomerOrderDetails | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        let active = true;
        void params.then(({ id }) => {
            if (active) setOrderId(id);
        });
        return () => { active = false; };
    }, [params]);

    useEffect(() => {
        if (!orderId) return;
        let active = true;
        void (async () => {
            try {
                const response = await fetch(`/api/user/orders/${encodeURIComponent(orderId)}`, { cache: 'no-store' });
                const result = await response.json();
                if (response.status === 401) {
                    router.replace('/user/login');
                    return;
                }
                if (!response.ok) throw new Error(result.error || 'Could not load order details');
                if (active) {
                    setDetails(result);
                    setError('');
                }
            } catch (reason: unknown) {
                if (active) setError(reason instanceof Error ? reason.message : 'Could not load order details');
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => { active = false; };
    }, [orderId, router]);

    return <>
        <header className="header">
            <div className="header-content">
                <BrandMark />
                <nav><Link href="/user/dashboard">My Orders</Link></nav>
            </div>
        </header>
        <main className="container" style={{ maxWidth: '900px' }}>
            <p style={{ margin: '1rem 0' }}><Link className="btn btn-secondary" href="/user/dashboard">← Back to My Orders</Link></p>
            {loading ? <div className="card"><div className="spinner" aria-label="Loading order details" /></div> : error ? (
                <div className="card"><div className="error-message" role="alert">{error}</div></div>
            ) : details && <section className="card">
                <div className="card-title-row">
                    <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Order {details.order.orderId}</h1>
                    <span className={`status-badge ${details.order.orderStatus === 'Completed' ? 'status-completed' : details.order.orderStatus === 'In Progress' ? 'status-in-progress' : 'status-submitted'}`}>
                        {details.order.orderStatus}
                    </span>
                </div>

                <section className="review-section">
                    <h2>Order details</h2>
                    <p><strong>Placed:</strong> {new Date(details.order.createdDate).toLocaleString('en-IN')}</p>
                    <p><strong>Current status:</strong> {details.order.orderStatus}</p>
                    <p><strong>College:</strong> {details.order.collegeName}</p>
                    <p><strong>Year:</strong> {details.order.yearOfStudying}</p>
                    <p><strong>Branch:</strong> {details.order.branch}</p>
                    <p><strong>Customer-provided files:</strong></p>
                    {details.order.uploadedFileNames.length > 0 ? (
                        <ul style={{ paddingLeft: '1.25rem' }}>
                            {details.order.uploadedFileNames.map((filename, index) => <li key={`${filename}-${index}`}>{filename}</li>)}
                        </ul>
                    ) : <p>No customer-provided files are recorded.</p>}
                    <p><strong>Instructions:</strong></p>
                    <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{details.order.instructions || 'No instructions recorded.'}</p>
                    {details.statusHistoryAvailable ? <p>Status history is available.</p> : <p style={{ color: '#6B7280' }}>A separate status history is not recorded for this order.</p>}
                </section>

                <section className="review-section">
                    <h2>Contact details</h2>
                    <p><strong>Name:</strong> {details.order.userName}</p>
                    <p><strong>Email:</strong> {details.order.email}</p>
                    <p><strong>Primary phone:</strong> {details.order.primaryPhone}</p>
                    {details.order.alternatePhone && <p><strong>Alternate phone:</strong> {details.order.alternatePhone}</p>}
                    {details.order.address && <p><strong>Address:</strong> {details.order.address}</p>}
                </section>

                <section className="review-section">
                    <h2>Payment information recorded</h2>
                    <p><strong>Amount:</strong> {details.order.priceAmount !== undefined ? `₹${details.order.priceAmount}` : 'No amount recorded'}</p>
                    <p><strong>Transaction/reference ID:</strong> {details.order.transactionId || 'No transaction/reference ID recorded'}</p>
                    <p style={{ color: '#6B7280' }}>Payment method, payment status, and confirmation time are not stored on this order record.</p>
                </section>

                <section className="review-section">
                    <h2>Delivery</h2>
                    <p><strong>Order delivery status:</strong> {details.order.orderStatus === 'Completed' && details.order.deliveryAvailable ? 'Delivered' : 'Not delivered'}</p>
                    <p><strong>Physical delivery status:</strong> {details.order.physicalDeliveryStatus || 'Not recorded'}</p>
                    {details.order.deliveryAvailable && details.order.deliveryDownloadUrl && (
                        <a className="btn btn-success" href={details.order.deliveryDownloadUrl} target="_blank" rel="noopener noreferrer">
                            ⬇ Download Completed Work
                        </a>
                    )}
                </section>

                <section className="review-section">
                    <h2>Customer review</h2>
                    {details.review.submitted ? (
                        <p className="success-message" role="status">
                            Rating submitted{details.review.rating !== undefined ? `: ${details.review.rating} out of 5` : ''}
                            {details.review.submittedAt ? ` on ${new Date(details.review.submittedAt).toLocaleString('en-IN')}` : ''}.
                        </p>
                    ) : details.review.eligible ? (
                        <p>A rating is required. Return to <Link href="/user/dashboard">My Orders</Link> to submit it.</p>
                    ) : <p>No review is recorded. This order is not currently eligible for a rating.</p>}
                </section>
            </section>}
        </main>
    </>;
}
