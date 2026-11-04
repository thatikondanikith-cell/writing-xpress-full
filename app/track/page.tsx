'use client';

import BrandMark from '@/components/BrandMark';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Order } from '@/lib/types';

type TrackingOrder = Pick<Order,
    'orderStatus' | 'physicalDeliveryStatus' | 'orderId' | 'branch' | 'createdDate'
> & {
    deliveryAvailable: boolean;
    deliveryFile?: string;
    deliveryDownloadToken?: string;
};

export default function TrackOrderPage() {
    const [orderId, setOrderId] = useState('');
    const [order, setOrder] = useState<TrackingOrder | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);

    useEffect(() => {
        const linkedOrderId = new URLSearchParams(window.location.search).get('orderId');
        if (linkedOrderId) setOrderId(linkedOrderId);
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setOrder(null);
        setSearched(false);

        if (!orderId.trim()) {
            setError('Please enter an Order ID');
            return;
        }

        setLoading(true);

        try {
            const response = await fetch(`/api/orders/${orderId.trim()}`);

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('Order not found. Please check your Order ID and try again.');
                }
                throw new Error('Failed to fetch order details');
            }

            const orderData = await response.json();
            setOrder(orderData);
            setSearched(true);

        } catch (err: any) {
            setError(err.message || 'An error occurred');
            setSearched(true);
        } finally {
            setLoading(false);
        }
    };

    const getStatusBadgeClass = (status: string) => {
        switch (status) {
            case 'Submitted':
                return 'status-badge status-submitted';
            case 'In Progress':
                return 'status-badge status-in-progress';
            case 'Completed':
                return 'status-badge status-completed';
            default:
                return 'status-badge';
        }
    };

    return (
        <>
            <header className="header">
                <div className="header-content">
                    <BrandMark />
                    <nav>
                        <Link href="/">Home</Link> 
                    </nav>
                </div>
            </header>

            <div className="container">
                <div className="card">
                    <h2>Track Your Order</h2>
                    <p style={{ color: '#6b7280', marginBottom: '1.5rem' }}>
                        Enter your Order ID to check the status of your order.
                    </p>

                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label>
                                Order ID <span className="required">*</span>
                            </label>
                            <input
                                type="text"
                                value={orderId}
                                onChange={(e) => setOrderId(e.target.value)}
                                placeholder="e.g., WX-20260209-0001"
                                style={{ fontFamily: 'monospace' }}
                            />
                        </div>

                        <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
                            {loading ? 'Searching...' : 'Track Order'}
                        </button>
                    </form>

                    {error && <div className="error-message mt-3">{error}</div>}

                    {order && (
                        <div className="mt-3">
                            <div className="success-message">
                                Order found!
                            </div>

                            <div className="review-section">
                                <h3 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Order Status</h3>
                                <div style={{ textAlign: 'center', padding: '2rem 0' }}>
                                    <div className={getStatusBadgeClass(order.orderStatus)} style={{
                                        fontSize: '1.25rem',
                                        padding: '0.75rem 2rem',
                                        display: 'inline-block'
                                    }}>
                                        {order.orderStatus}
                                    </div>
                                </div>
                            </div>

                            {order.orderStatus === 'Submitted' && (
                            <div className="review-section review-section--info">
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
                                        <span className="tracking-note-icon" aria-hidden="true">01</span>
                                        <div>
                                            <h3>Order Received</h3>
                                            <p>
                                                Your order has been received and will be shortly assigned to a writer.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {order.deliveryAvailable && (
                                <div className="review-section review-section--success">
                                    <h3>Download Delivered File</h3>
                                    <p>
                                        Your order has been completed and the file is ready for download.
                                    </p>
                                    {order.deliveryFile && order.deliveryDownloadToken ? (
                                        <a
                                            href={`/api/files/${encodeURIComponent(order.deliveryFile)}?token=${encodeURIComponent(order.deliveryDownloadToken)}`}
                                            download
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="btn btn-success btn-block"
                                        >
                                            Download File
                                        </a>
                                    ) : (
                                        <p>
                                            <Link href="/user/login" style={{ textDecoration: 'underline' }}>Sign in</Link> with the account used for this order to download the file.
                                        </p>
                                    )}
                                </div>
                            )}

                            {order.orderStatus === 'Completed' && (
                                <div className={`review-section ${order.physicalDeliveryStatus === 'Delivered' ? 'review-section--success' : 'review-section--info'}`}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
                                        <svg className="tracking-delivery-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
                                            <path d="M3 6.5h11v10H3zM14 10h4l3 3v3.5h-7z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                                            <circle cx="7.5" cy="18" r="1.8" stroke="currentColor" strokeWidth="1.7" />
                                            <circle cx="18" cy="18" r="1.8" stroke="currentColor" strokeWidth="1.7" />
                                        </svg>
                                        <div>
                                            <h3>
                                                {order.physicalDeliveryStatus === 'Delivered' ? 'Physical Delivery Completed' : 'Physical Delivery Pending'}
                                            </h3>
                                            <p>
                                                {order.physicalDeliveryStatus === 'Delivered'
                                                    ? 'Your physical copy has been successfully delivered.'
                                                    : 'Your physical copy will be delivered shortly to your registered address.'}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="review-section">
                                <h3 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Order Details</h3>

                                <div className="review-item">
                                    <div className="review-label">Order ID:</div>
                                    <div className="review-value" style={{ fontFamily: 'monospace' }}>
                                        {order.orderId}
                                    </div>
                                </div>

                                <div className="review-item">
                                    <div className="review-label">Branch:</div>
                                    <div className="review-value">{order.branch}</div>
                                </div>

                                <div className="review-item">
                                    <div className="review-label">Submitted On:</div>
                                    <div className="review-value">
                                        {new Date(order.createdDate).toLocaleString('en-IN', {
                                            day: '2-digit',
                                            month: 'long',
                                            year: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit'
                                        })}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {searched && !order && !error && (
                        <div className="error-message mt-3">
                            No order found with the provided Order ID.
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
