'use client';

import BrandMark from '@/components/BrandMark';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createOrderConfirmationSnapshot } from '@/lib/order-confirmation';

export default function PaymentPage() {
    const router = useRouter();
    const [price, setPrice] = useState(0);
    const [transactionId, setTransactionId] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [submissionData, setSubmissionData] = useState<any>(null);

    useEffect(() => {
        const data = sessionStorage.getItem('submissionData');
        const priceStr = sessionStorage.getItem('orderPrice');

        if (!data || !priceStr) {
            router.push('/submit');
            return;
        }

        setSubmissionData(JSON.parse(data));
        setPrice(parseInt(priceStr, 10));
    }, [router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!transactionId.trim()) {
            setError('Please enter a valid Transaction ID');
            return;
        }

        if (typeof submissionData?.uploadToken !== 'string' || !submissionData.uploadToken) {
            setError('Your uploaded files could not be verified. Please return to the submission form and upload them again.');
            return;
        }

        setLoading(true);

        try {
            // Create order
            const orderPayload = {
                ...submissionData,
                priceAmount: price,
                transactionId: transactionId.trim(),
            };

            const response = await fetch('/api/orders', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(orderPayload),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to submit order');
            }

            const newOrder = await response.json();

            const confirmationSnapshot = createOrderConfirmationSnapshot(newOrder);
            if (confirmationSnapshot) {
                sessionStorage.setItem('newOrderConfirmation', JSON.stringify(confirmationSnapshot));
            } else {
                sessionStorage.removeItem('newOrderConfirmation');
            }

            // Store order ID in sessionStorage as backup
            sessionStorage.setItem('newOrderId', newOrder.orderId);

            // Clear form data
            sessionStorage.removeItem('submissionData');
            sessionStorage.removeItem('orderPrice');

            // Navigate to confirmation with orderId in URL
            router.push(`/submit/confirmation?orderId=${newOrder.orderId}`);

        } catch (err: any) {
            setError(err.message || 'An error occurred while submitting your order');
            setLoading(false);
        }
    };

    if (!submissionData) {
        return (
            <div className="container">
                <div className="spinner"></div>
            </div>
        );
    }

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
                {/* Progress Steps */}
                <div className="progress-steps">
                    <div className="progress-step completed">
                        <div className="progress-step-number">1</div>
                        <div className="progress-step-label">Details</div>
                    </div>
                    <div className="progress-step completed">
                        <div className="progress-step-number">2</div>
                        <div className="progress-step-label">Review</div>
                    </div>
                    <div className="progress-step active">
                        <div className="progress-step-number">3</div>
                        <div className="progress-step-label">Payment</div>
                    </div>
                    <div className="progress-step">
                        <div className="progress-step-number">4</div>
                        <div className="progress-step-label">Confirmation</div>
                    </div>
                </div>

                <div className="card">
                    <h2>Payment</h2>

                    <div className="review-section" style={{ backgroundColor: '#FEE2E2' }}>
                        <h3 style={{ fontSize: '1.25rem', marginBottom: '0.5rem', color: '#DC2626' }}>
                            Amount to Pay
                        </h3>
                        <div style={{ fontSize: '2rem', fontWeight: '700', color: '#DC2626' }}>
                            ₹{price}
                        </div>
                    </div>

                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Payment Instructions</h3>
                        <p style={{ marginBottom: '1rem', color: '#1f2937' }}>
                            Please make the payment using one of the following methods:
                        </p>
                        <div style={{ backgroundColor: 'white', padding: '1rem', borderRadius: '4px', border: '1px solid #e5e7eb' }}>
                            <p style={{ marginBottom: '0.5rem' }}><strong>UPI ID:</strong> writingxpress@upi</p>
                            <p style={{ marginBottom: '0.5rem' }}><strong>Account Name:</strong> Writing Xpress</p>
                            <p style={{ marginBottom: '0.5rem' }}><strong>Bank:</strong> State Bank of India</p>
                            <p style={{ marginBottom: '0.5rem' }}><strong>Account Number:</strong> 1234567890</p>
                            <p><strong>IFSC Code:</strong> SBIN0001234</p>
                        </div>
                    </div>

                    {error && <div className="error-message">{error}</div>}

                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label>
                                Transaction ID <span className="required">*</span>
                            </label>
                            <input
                                type="text"
                                value={transactionId}
                                onChange={(e) => setTransactionId(e.target.value)}
                                placeholder="Enter your transaction/reference ID"
                                required
                            />
                            <small style={{ color: '#6b7280', marginTop: '0.25rem', display: 'block' }}>
                                After making the payment, enter the transaction/reference ID you received
                            </small>
                        </div>

                        <div className="flex gap-2 mt-3">
                            <button
                                type="button"
                                onClick={() => router.back()}
                                className="btn btn-secondary"
                                style={{ flex: 1 }}
                                disabled={loading}
                            >
                                Back
                            </button>
                            <button
                                type="submit"
                                className="btn btn-primary"
                                style={{ flex: 1 }}
                                disabled={loading}
                            >
                                {loading ? 'Submitting...' : 'Submit Order'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </>
    );
}
