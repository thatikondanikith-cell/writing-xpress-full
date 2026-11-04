'use client';

import BrandMark from '@/components/BrandMark';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const BASE_PRICE = 500; // Base price in INR

export default function ReviewPage() {
    const router = useRouter();
    const [submissionData, setSubmissionData] = useState<any>(null);
    const [price, setPrice] = useState(BASE_PRICE);

    useEffect(() => {
        // Get data from sessionStorage
        const data = sessionStorage.getItem('submissionData');
        if (!data) {
            router.push('/submit');
            return;
        }

        const parsedData = JSON.parse(data);
        setSubmissionData(parsedData);

        // Calculate price based on files (you can customize this logic)
        const calculatedPrice = BASE_PRICE + (parsedData.uploadedFiles.length - 1) * 100;
        setPrice(calculatedPrice);
    }, [router]);

    const handleContinue = () => {
        // Store price for next step
        sessionStorage.setItem('orderPrice', price.toString());
        router.push('/submit/payment');
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
                    <div className="progress-step active">
                        <div className="progress-step-number">2</div>
                        <div className="progress-step-label">Review</div>
                    </div>
                    <div className="progress-step">
                        <div className="progress-step-number">3</div>
                        <div className="progress-step-label">Payment</div>
                    </div>
                    <div className="progress-step">
                        <div className="progress-step-number">4</div>
                        <div className="progress-step-label">Confirmation</div>
                    </div>
                </div>

                <div className="card">
                    <h2>Review Your Details</h2>
                    <p style={{ color: '#6b7280', marginBottom: '1.5rem' }}>
                        Please review all the information you've provided before proceeding to payment.
                    </p>

                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Personal Information</h3>
                        <div className="review-item">
                            <div className="review-label">Name:</div>
                            <div className="review-value">{submissionData.userName}</div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Primary Phone:</div>
                            <div className="review-value">{submissionData.primaryPhone}</div>
                        </div>
                        {submissionData.alternatePhone && (
                            <div className="review-item">
                                <div className="review-label">Alternate Phone:</div>
                                <div className="review-value">{submissionData.alternatePhone}</div>
                            </div>
                        )}
                        <div className="review-item">
                            <div className="review-label">Email:</div>
                            <div className="review-value">{submissionData.email}</div>
                        </div>
                        {submissionData.address && (
                            <div className="review-item">
                                <div className="review-label">Address:</div>
                                <div className="review-value">{submissionData.address}</div>
                            </div>
                        )}
                    </div>

                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Academic Information</h3>
                        <div className="review-item">
                            <div className="review-label">College Name:</div>
                            <div className="review-value">{submissionData.collegeName}</div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Year of Studying:</div>
                            <div className="review-value">{submissionData.yearOfStudying}</div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Branch:</div>
                            <div className="review-value">{submissionData.branch}</div>
                        </div>
                    </div>

                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Requirements</h3>
                        <div className="review-item">
                            <div className="review-label">Uploaded Files:</div>
                            <div className="review-value">
                                {submissionData.uploadedFiles.length} file(s)
                                <ul style={{ marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
                                    {(submissionData.uploadedFileNames || submissionData.uploadedFiles).map((name: string, index: number) => (
                                        <li key={index}>{name}</li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Instructions:</div>
                            <div className="review-value" style={{ whiteSpace: 'pre-wrap' }}>
                                {submissionData.instructions}
                            </div>
                        </div>
                    </div>

                    <div className="review-section" style={{ backgroundColor: '#FEE2E2' }}>
                        <h3 style={{ fontSize: '1.25rem', marginBottom: '0.5rem', color: '#DC2626' }}>
                            Total Price
                        </h3>
                        <div style={{ fontSize: '2rem', fontWeight: '700', color: '#DC2626' }}>
                            ₹{price}
                        </div>
                    </div>

                    <div className="flex gap-2 mt-3">
                        <button
                            onClick={() => router.back()}
                            className="btn btn-secondary"
                            style={{ flex: 1 }}
                        >
                            Back to Edit
                        </button>
                        <button
                            onClick={handleContinue}
                            className="btn btn-primary"
                            style={{ flex: 1 }}
                        >
                            Proceed to Payment
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
