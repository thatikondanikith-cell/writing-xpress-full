'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import AdminNav from '@/app/admin/AdminNav';
import { Order, OrderStatus } from '@/lib/types';

type AssignmentData = {
    orderStatus: OrderStatus;
    assignment: {
        writerId: string | null;
        writer: { id: string; name: string; email: string; isAvailable: boolean; applicationStatus: string } | null;
        assignedAt?: string;
        assignedByAdminId?: string;
        status?: 'pending_acceptance' | 'accepted';
        responseDeadline?: string;
        overrideReason?: string;
        overrideAt?: string;
        overrideByAdminId?: string;
        version: number;
    };
    eligibleWriters: Array<{
        id: string;
        name: string;
        email: string;
        isAvailable: boolean;
        activeOrderCount: number;
        workloadLabel: string;
        performance: {
            rating: number;
            reviewCount: number;
            ratingIsProvisional: boolean;
            acceptanceRate: number | null;
            acceptedOffers: number;
            resolvedOffers: number;
            completionRate: number | null;
            completedAcceptedAssignments: number;
            acceptedAssignments: number;
            onTimeCompletionRate: null;
        };
    }>;
    completionCandidates: Array<{
        writerId: string;
        assignmentVersion: number;
        name: string;
        email: string;
    }>;
};

export default function OrderDetailsPage({ params }: { params: Promise<{ id: string }> }) {
    const [orderId, setOrderId] = useState<string | null>(null);
    const [order, setOrder] = useState<Order | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [updating, setUpdating] = useState(false);
    const [successMessage, setSuccessMessage] = useState('');

    const [newStatus, setNewStatus] = useState<OrderStatus>('Submitted');
    const [deliveryFile, setDeliveryFile] = useState<File | null>(null);
    const [assignment, setAssignment] = useState<AssignmentData | null>(null);
    const [assignmentLoading, setAssignmentLoading] = useState(true);
    const [assignmentError, setAssignmentError] = useState('');
    const [assignmentSuccess, setAssignmentSuccess] = useState('');
    const [assignmentSaving, setAssignmentSaving] = useState(false);
    const [selectedWriterId, setSelectedWriterId] = useState('');
    const [overrideUnavailable, setOverrideUnavailable] = useState(false);
    const [overrideReason, setOverrideReason] = useState('');
    const [completionCandidateKey, setCompletionCandidateKey] = useState('');

    const writerManagedOrder = Boolean(order && (
        order.assignedWriterId || order.assignedAt || order.assignmentHistory?.length ||
        order.writerSubmissions?.length || order.currentWriterSubmissionId || order.approvedSubmissionId ||
        (order.writerWorkflowStatus && order.writerWorkflowStatus !== 'not_started')
    ));
    const currentApprovedSubmission = order?.writerSubmissions?.find((submission) =>
        submission.submissionId === order.approvedSubmissionId &&
        submission.submissionId === order.currentWriterSubmissionId &&
        submission.reviewStatus === 'approved' &&
        submission.assignmentVersion === (order.assignmentVersion || 0) &&
        submission.writerId === order.assignedWriterId
    );

    useEffect(() => {
        // Await params and get orderId
        params.then(({ id }) => setOrderId(id));
    }, [params]);

    useEffect(() => {
        if (!orderId) return;

        fetchOrder();
        fetchAssignment();
    }, [orderId]);

    useEffect(() => {
        if (!orderId) return;
        const refreshAssignmentMetrics = () => {
            if (document.visibilityState === 'visible') void fetchAssignment();
        };
        const timer = window.setInterval(refreshAssignmentMetrics, 30_000);
        window.addEventListener('focus', refreshAssignmentMetrics);
        document.addEventListener('visibilitychange', refreshAssignmentMetrics);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', refreshAssignmentMetrics);
            document.removeEventListener('visibilitychange', refreshAssignmentMetrics);
        };
    }, [orderId]);

    const fetchOrder = async () => {
        if (!orderId) return;

        try {
            const response = await fetch(`/api/orders/${orderId}`, { cache: 'no-store' });

            if (!response.ok) {
                throw new Error('Order not found');
            }

            const data = await response.json();
            setOrder(data);
            setNewStatus(data.orderStatus);

        } catch (err: any) {
            setError(err.message || 'Failed to fetch order');
        } finally {
            setLoading(false);
        }
    };

    const fetchAssignment = async () => {
        if (!orderId) return;
        try {
            const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/assignment`, { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not load assignment options');
            setAssignment(data);
            setCompletionCandidateKey((current) => data.completionCandidates.some((candidate: AssignmentData['completionCandidates'][number]) => `${candidate.writerId}:${candidate.assignmentVersion}` === current) ? current : '');
            setSelectedWriterId((current) => current || data.assignment.writerId || data.eligibleWriters.find((writer: AssignmentData['eligibleWriters'][number]) => writer.isAvailable)?.id || data.eligibleWriters[0]?.id || '');
        } catch (reason: unknown) {
            setAssignmentError(reason instanceof Error ? reason.message : 'Could not load assignment options');
        } finally {
            setAssignmentLoading(false);
        }
    };

    const saveAssignment = async () => {
        if (!assignment || !selectedWriterId || assignmentSaving) return;
        const writer = assignment.eligibleWriters.find((item) => item.id === selectedWriterId);
        if (!writer) {
            setAssignmentError('Select an approved writer.');
            return;
        }
        if (selectedWriterId === assignment.assignment.writerId) {
            setAssignmentError('Choose a different writer to reassign this order.');
            return;
        }
        if (!writer.isAvailable && (!overrideUnavailable || overrideReason.trim().length < 3)) {
            setAssignmentError('An unavailable-writer override and a reason are required.');
            return;
        }

        setAssignmentSaving(true);
        setAssignmentError('');
        setAssignmentSuccess('');
        try {
            const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId!)}/assignment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    writerId: selectedWriterId,
                    expectedWriterId: assignment.assignment.writerId,
                    expectedAssignmentVersion: assignment.assignment.version,
                    overrideUnavailable: !writer.isAvailable && overrideUnavailable,
                    ...(!writer.isAvailable && overrideUnavailable ? { overrideReason } : {}),
                }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not save order assignment');
            await fetchAssignment();
            setOverrideUnavailable(false);
            setOverrideReason('');
            setAssignmentSuccess(`Order assigned to ${writer.name}.`);
        } catch (reason: unknown) {
            setAssignmentError(reason instanceof Error ? reason.message : 'Could not save order assignment');
        } finally {
            setAssignmentSaving(false);
        }
    };

    const handleUpdateStatus = async () => {
        if (newStatus === 'Completed' && order?.deliveryFile && (assignment?.completionCandidates.length || 0) > 0 && !completionCandidateKey) {
            setError('Select the writer who completed this order before marking delivery complete.');
            return;
        }
        setError('');
        setSuccessMessage('');
        setUpdating(true);

        try {
            const response = await fetch(`/api/orders/${orderId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    orderStatus: newStatus,
                    ...(newStatus === 'Completed' && completionCandidateKey ? {
                        completedByWriterId: completionCandidateKey.split(':')[0],
                        completedAssignmentVersion: Number(completionCandidateKey.split(':')[1]),
                    } : {}),
                }),
            });

            if (!response.ok) {
                throw new Error('Failed to update status');
            }

            const updatedOrder = await response.json();
            setOrder(updatedOrder);
            setSuccessMessage('Order status updated successfully');
            await fetchAssignment();

        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setUpdating(false);
        }
    };

    const handleUploadDelivery = async () => {
        if (!deliveryFile) {
            setError('Please select a file to upload');
            return;
        }
        if ((assignment?.completionCandidates.length || 0) > 0 && !completionCandidateKey) {
            setError('Select the writer who completed this order before uploading its delivery.');
            return;
        }

        setError('');
        setSuccessMessage('');
        setUpdating(true);

        try {
            const formData = new FormData();
            formData.append('deliveryFile', deliveryFile);
            formData.append('orderStatus', 'Completed');
            if (completionCandidateKey) {
                const [writerId, version] = completionCandidateKey.split(':');
                formData.append('completedByWriterId', writerId);
                formData.append('completedAssignmentVersion', version);
            }

            const response = await fetch(`/api/orders/${orderId}`, {
                method: 'PUT',
                body: formData,
            });

            if (!response.ok) {
                throw new Error('Failed to upload delivery file');
            }

            const updatedOrder = await response.json();
            setOrder(updatedOrder);
            setNewStatus('Completed');
            setDeliveryFile(null);
            setSuccessMessage('Delivery file uploaded and order marked as completed');
            await fetchAssignment();

        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setUpdating(false);
        }
    };

    const handleDeliverApprovedSubmission = async () => {
        const approvedSubmission = order?.writerSubmissions?.find((submission) =>
            submission.submissionId === order.approvedSubmissionId &&
            submission.submissionId === order.currentWriterSubmissionId &&
            submission.reviewStatus === 'approved'
        );
        if (!order || !approvedSubmission || updating) return;

        setError('');
        setSuccessMessage('');
        setUpdating(true);
        try {
            const response = await fetch(`/api/orders/${encodeURIComponent(orderId!)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deliverApprovedSubmissionId: approvedSubmission.submissionId }),
            });
            let result: Order | { error?: unknown } | null = null;
            try {
                result = await response.json();
            } catch {
                // Handle non-JSON responses from proxies or server failures without masking the HTTP status.
            }
            if (!response.ok) {
                const message = result && 'error' in result && typeof result.error === 'string'
                    ? result.error
                    : `Could not deliver the approved submission (HTTP ${response.status}).`;
                throw new Error(message);
            }
            if (!result || !('orderStatus' in result) || result.orderStatus !== 'Completed' || result.deliveryFile !== approvedSubmission.fileId) {
                throw new Error('The server did not confirm delivery of the approved submission. Refresh the order before retrying.');
            }
            setOrder(result);
            setNewStatus(result.orderStatus);
            setSuccessMessage('Approved writer submission delivered and order marked as completed.');
            await fetchAssignment();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Could not deliver the approved submission');
        } finally {
            setUpdating(false);
        }
    };

    if (loading) {
        return (
            <>
            <AdminNav />
            <div className="container">
                <div className="spinner"></div>
            </div>
            </>
        );
    }

    if (error && !order) {
        return (
            <>
                <AdminNav />
                <div className="container">
                    <div className="error-message">{error}</div>
                    <Link href="/admin/dashboard" className="btn btn-secondary">
                        Back to Dashboard
                    </Link>
                </div>
            </>
        );
    }

    if (!order) return null;

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
            <AdminNav />

            <main className="container admin-page admin-order-page">
                <div className="mb-2">
                    <Link href="/admin/dashboard" className="btn btn-secondary">
                        ← Back to Dashboard
                    </Link>
                </div>

                <div className="card admin-panel">
                    <div className="card-title-row">
                        <h2 style={{ marginBottom: 0 }}>Order Details</h2>
                        <span className={getStatusBadgeClass(order.orderStatus)} style={{ fontSize: '1rem' }}>
                            {order.orderStatus}
                        </span>
                    </div>

                    {error && <div className="error-message">{error}</div>}
                    {successMessage && <div className="success-message">{successMessage}</div>}

                    {/* Order Information */}
                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Order Information</h3>
                        <div className="review-item">
                            <div className="review-label">Order ID:</div>
                            <div className="review-value" style={{ fontFamily: 'monospace' }}>{order.orderId}</div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Created Date:</div>
                            <div className="review-value">
                                {new Date(order.createdDate).toLocaleString('en-IN')}
                            </div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Price:</div>
                            <div className="review-value">₹{order.priceAmount}</div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Transaction ID:</div>
                            <div className="review-value" style={{ fontFamily: 'monospace' }}>{order.transactionId}</div>
                        </div>
                    </div>

                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Writer Assignment</h3>
                        {assignmentError && <div className="error-message" role="alert">{assignmentError}</div>}
                        {assignmentSuccess && <div className="success-message" role="status">{assignmentSuccess}</div>}
                        {assignmentLoading ? <div className="spinner" /> : assignment && (
                            <>
                                <p>
                                    Current assignment:{' '}
                                    <strong>
                                        {assignment.assignment.writer
                                            ? `${assignment.assignment.writer.name} (${assignment.assignment.writer.email})`
                                            : 'Unassigned'}
                                    </strong>
                                </p>
                                <p>Internal writer review status: <strong>{(order.writerWorkflowStatus || (order.assignedWriterId ? 'assigned' : 'not_started')).replaceAll('_', ' ')}</strong></p>
                                {order.currentWriterSubmissionId && (
                                    <p><Link href={`/admin/writer-review/${encodeURIComponent(order.orderId)}`}>Open current writer submission review</Link></p>
                                )}
                                {assignment.assignment.assignedAt && (
                                    <p style={{ color: '#6b7280' }}>Assigned {new Date(assignment.assignment.assignedAt).toLocaleString('en-IN')}</p>
                                )}
                                {assignment.assignment.writerId && (
                                    <p>
                                        Assignment state:{' '}
                                        <strong>{assignment.assignment.status === 'pending_acceptance' ? 'Awaiting writer response' : 'Accepted'}</strong>
                                        {assignment.assignment.responseDeadline && assignment.assignment.status === 'pending_acceptance' && (
                                            <> · response due {new Date(assignment.assignment.responseDeadline).toLocaleString('en-IN')}</>
                                        )}
                                    </p>
                                )}
                                {assignment.assignment.overrideReason && (
                                    <p style={{ color: '#92400e' }}>Unavailable-writer override: {assignment.assignment.overrideReason}</p>
                                )}
                                {assignment.orderStatus === 'Completed' ? (
                                    <p>Completed orders are excluded from new assignment and active workload.</p>
                                ) : (
                                    <>
                                        <div className="form-group">
                                            <label htmlFor="assigned-writer">Approved writer</label>
                                            <select
                                                id="assigned-writer"
                                                value={selectedWriterId}
                                                onChange={(event) => {
                                                    setSelectedWriterId(event.target.value);
                                                    setOverrideUnavailable(false);
                                                    setOverrideReason('');
                                                    setAssignmentError('');
                                                }}
                                            >
                                                <option value="" disabled>Select a writer</option>
                                                {assignment.eligibleWriters.map((writer) => (
                                                    <option key={writer.id} value={writer.id}>
                                                        {writer.name} — {writer.email} — {writer.workloadLabel} — {writer.performance.rating.toFixed(1)}{writer.performance.ratingIsProvisional ? ' provisional' : ''} ({writer.performance.reviewCount} reviews) — acceptance {writer.performance.acceptanceRate === null ? 'N/A' : `${writer.performance.acceptanceRate.toFixed(1)}%`} — completion {writer.performance.completionRate === null ? 'N/A' : `${writer.performance.completionRate.toFixed(1)}%`}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        {assignment.eligibleWriters.find((writer) => writer.id === selectedWriterId) && (() => {
                                            const selected = assignment.eligibleWriters.find((writer) => writer.id === selectedWriterId)!;
                                            const metrics = selected.performance;
                                            return <div className="review-section" aria-label="Selected writer performance">
                                                <h4>{selected.name} performance</h4>
                                                <p>Customer rating: <strong>{metrics.rating.toFixed(1)}{metrics.ratingIsProvisional ? ' provisional' : ''}</strong> · {metrics.reviewCount} {metrics.reviewCount === 1 ? 'review' : 'reviews'}</p>
                                                <p>Acceptance rate: <strong>{metrics.acceptanceRate === null ? 'N/A' : `${metrics.acceptanceRate.toFixed(1)}%`}</strong> · {metrics.acceptedOffers}/{metrics.resolvedOffers} accepted/resolved offers</p>
                                                <p>Completion rate: <strong>{metrics.completionRate === null ? 'N/A' : `${metrics.completionRate.toFixed(1)}%`}</strong> · {metrics.completedAcceptedAssignments}/{metrics.acceptedAssignments} accepted assignments completed</p>
                                                <p>On-time completion: <strong>Unavailable</strong> · no reliable work deadlines are stored</p>
                                            </div>;
                                        })()}
                                        {assignment.eligibleWriters.length === 0 && <p>No approved writer accounts are available for assignment.</p>}
                                        {assignment.eligibleWriters.find((writer) => writer.id === selectedWriterId)?.isAvailable === false && (
                                            <div className="form-group">
                                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={overrideUnavailable}
                                                        onChange={(event) => setOverrideUnavailable(event.target.checked)}
                                                        disabled={assignmentSaving}
                                                    />
                                                    Confirm assignment to this Unavailable writer
                                                </label>
                                                {overrideUnavailable && (
                                                    <>
                                                        <label htmlFor="override-reason">Override reason (3–500 characters)</label>
                                                        <textarea
                                                            id="override-reason"
                                                            value={overrideReason}
                                                            maxLength={500}
                                                            onChange={(event) => setOverrideReason(event.target.value)}
                                                            disabled={assignmentSaving}
                                                        />
                                                    </>
                                                )}
                                            </div>
                                        )}
                                        <button
                                            className="btn btn-primary"
                                            onClick={saveAssignment}
                                            disabled={assignmentSaving || !selectedWriterId || selectedWriterId === assignment.assignment.writerId || (
                                                assignment.eligibleWriters.find((writer) => writer.id === selectedWriterId)?.isAvailable === false &&
                                                (!overrideUnavailable || overrideReason.trim().length < 3)
                                            )}
                                        >
                                            {assignmentSaving ? 'Saving assignment...' : assignment.assignment.writerId ? 'Reassign Order' : 'Assign Order'}
                                        </button>
                                        <p style={{ color: '#6b7280', marginTop: '0.75rem' }}>
                                            Active workload counts Submitted and In Progress orders. Unavailable writers require an explicit, audited override.
                                        </p>
                                    </>
                                )}
                            </>
                        )}
                    </div>

                    {/* User Information */}
                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>User Information</h3>
                        <div className="review-item">
                            <div className="review-label">Name:</div>
                            <div className="review-value">{order.userName}</div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Primary Phone:</div>
                            <div className="review-value">{order.primaryPhone}</div>
                        </div>
                        {order.alternatePhone && (
                            <div className="review-item">
                                <div className="review-label">Alternate Phone:</div>
                                <div className="review-value">{order.alternatePhone}</div>
                            </div>
                        )}
                        <div className="review-item">
                            <div className="review-label">Email:</div>
                            <div className="review-value">{order.email}</div>
                        </div>
                        {order.address && (
                            <div className="review-item">
                                <div className="review-label">Address:</div>
                                <div className="review-value">{order.address}</div>
                            </div>
                        )}
                        <div className="review-item">
                            <div className="review-label">College:</div>
                            <div className="review-value">{order.collegeName}</div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Year of Studying:</div>
                            <div className="review-value">{order.yearOfStudying}</div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Branch:</div>
                            <div className="review-value">{order.branch}</div>
                        </div>
                    </div>

                    {/* Requirements */}
                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Requirements</h3>
                        <div className="review-item">
                            <div className="review-label">Uploaded Files:</div>
                            <div className="review-value">
                                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                                    {order.uploadedFiles.map((fileId, index) => (
                                        <li key={index}>
                                            <a href={`/api/files/${encodeURIComponent(fileId)}`} target="_blank" rel="noopener noreferrer">
                                                File {index + 1}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                        <div className="review-item">
                            <div className="review-label">Instructions:</div>
                            <div className="review-value" style={{ whiteSpace: 'pre-wrap' }}>
                                {order.instructions}
                            </div>
                        </div>
                    </div>

                    {/* Update Status */}
                    {assignment && assignment.completionCandidates.length > 0 && (
                        <div className="review-section">
                            <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Completion Attribution</h3>
                            <p>Select the accepted assignment that completed this order. This selection is recorded with delivery completion and controls customer-rating attribution.</p>
                            <div className="form-group">
                                <label htmlFor="completion-writer">Writer who completed the order</label>
                                <select
                                    id="completion-writer"
                                    value={completionCandidateKey}
                                    onChange={(event) => setCompletionCandidateKey(event.target.value)}
                                >
                                    <option value="">Select the completing writer</option>
                                    {assignment.completionCandidates.map((candidate) => (
                                        <option key={`${candidate.writerId}:${candidate.assignmentVersion}`} value={`${candidate.writerId}:${candidate.assignmentVersion}`}>
                                            {candidate.name} — {candidate.email} — assignment {candidate.assignmentVersion}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    )}

                    {/* Update Status */}
                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Update Order Status</h3>
                        <div className="form-group">
                            <label>Order Status</label>
                            <select
                                value={newStatus}
                                onChange={(e) => setNewStatus(e.target.value as OrderStatus)}
                            >
                                <option value="Submitted" disabled={order.orderStatus !== 'Submitted'}>Submitted</option>
                                <option value="In Progress" disabled={order.orderStatus === 'Completed'}>In Progress</option>
                                <option
                                    value="Completed"
                                    disabled={writerManagedOrder || order.orderStatus !== 'In Progress' || !order.deliveryFile}
                                >Completed</option>
                            </select>
                        </div>
                        <button
                            onClick={handleUpdateStatus}
                            className="btn btn-primary"
                            disabled={updating || newStatus === order.orderStatus}
                        >
                            {updating ? 'Updating...' : 'Update Status'}
                        </button>
                    </div>

                    {/* Physical Delivery Status */}
                    {order.orderStatus === 'Completed' && (
                        <div className="review-section">
                            <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Physical Delivery</h3>
                            <div className="responsive-actions" style={{ alignItems: 'center', gap: '1rem' }}>
                                <div>
                                    Current Status: <strong>{order.physicalDeliveryStatus || 'Pending'}</strong>
                                </div>
                                <button
                                    onClick={async () => {
                                        if (!orderId) return;
                                        setUpdating(true);
                                        try {
                                            const newPhysicalStatus = order.physicalDeliveryStatus === 'Delivered' ? 'Pending' : 'Delivered';
                                            const response = await fetch(`/api/orders/${orderId}`, {
                                                method: 'PUT',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ physicalDeliveryStatus: newPhysicalStatus }),
                                            });
                                            if (!response.ok) throw new Error('Failed to update physical status');
                                            const updated = await response.json();
                                            setOrder(updated);
                                            setSuccessMessage(`Physical delivery status updated to ${newPhysicalStatus}`);
                                        } catch (err: any) {
                                            setError(err.message);
                                        } finally {
                                            setUpdating(false);
                                        }
                                    }}
                                    className={`btn ${order.physicalDeliveryStatus === 'Delivered' ? 'btn-secondary' : 'btn-success'}`}
                                    disabled={updating}
                                >
                                    {order.physicalDeliveryStatus === 'Delivered' ? 'Mark as Pending' : 'Mark as Delivered'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Upload Delivery File */}
                    <div className="review-section">
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Delivery File</h3>

                        {writerManagedOrder && <div style={{ marginBottom: '1rem' }}>
                            <p><strong>Writer submission:</strong> {currentApprovedSubmission
                                ? (order.deliveryFile && order.deliveryFile !== currentApprovedSubmission.fileId
                                    ? 'Approved submission is ready, but a different file is already marked for delivery'
                                    : order.deliveryFile === currentApprovedSubmission.fileId && order.orderStatus === 'Completed'
                                        ? 'Approved submission delivered'
                                        : 'Approved and ready for customer delivery')
                                : 'No current approved submission is ready for delivery'}.</p>
                            {currentApprovedSubmission &&
                                (!order.deliveryFile || order.deliveryFile === currentApprovedSubmission.fileId) &&
                                !(order.deliveryFile === currentApprovedSubmission.fileId && order.orderStatus === 'Completed') && (
                                <button type="button" className="btn btn-success" onClick={() => void handleDeliverApprovedSubmission()} disabled={updating}>
                                    {updating ? 'Delivering approved work...' : 'Deliver approved submission to customer'}
                                </button>
                            )}
                            <p style={{ color: '#6b7280', marginTop: '0.5rem' }}>
                                Admin approval is internal review only. Customer delivery starts only when this action succeeds.
                            </p>
                        </div>}

                        {order.deliveryFile && (
                            <div className="mb-2">
                                <p style={{ marginBottom: '0.5rem' }}>Current delivery file:</p>
                                <a
                                    href={`/api/files/${order.deliveryFile}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn btn-secondary"
                                    style={{ display: 'inline-block' }}
                                >
                                    Download Current File
                                </a>
                            </div>
                        )}

                        {assignment && assignment.completionCandidates.length === 0 && (
                            <p style={{ color: '#6b7280' }}>
                                No accepted assignment can be attributed to this delivery. Customer feedback and writer completion credit will remain unavailable for it.
                            </p>
                        )}

                        {!writerManagedOrder && (
                            <>
                                <div className="form-group">
                                    <label>Upload Delivery File (will mark order as Completed)</label>
                                    <input
                                        type="file"
                                        onChange={(e) => setDeliveryFile(e.target.files?.[0] || null)}
                                    />
                                </div>
                                <button
                                    onClick={handleUploadDelivery}
                                    className="btn btn-success"
                                    disabled={updating || !deliveryFile || order.orderStatus !== 'In Progress'}
                                >
                                    {updating ? 'Uploading...' : 'Upload & Mark as Completed'}
                                </button>
                                {order.orderStatus === 'Submitted' && <p style={{ color: '#6b7280' }}>Move this order to In Progress before uploading its delivery.</p>}
                            </>
                        )}
                    </div>
                </div>
            </main>
        </>
    );
}
