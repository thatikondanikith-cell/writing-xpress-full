'use client';

import { useCallback, useEffect, useState } from 'react';
import AdminNav from '@/app/admin/AdminNav';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type ReviewPageData = {
    order: {
        orderId: string;
        orderStatus: string;
        deliveryFile: string | null;
        userName: string;
        collegeName: string;
        yearOfStudying: string;
        branch: string;
        instructions: string;
        createdDate: string;
    };
    assignment: { writerId: string | null; status: string | null; version: number };
    workflowStatus: string;
    currentSubmissionId: string | null;
    approvedSubmissionId: string | null;
    submissions: Array<{
        submissionId: string;
        writerId: string;
        writer: { name: string; email: string };
        assignmentVersion: number;
        submittedAt: string;
        reviewStatus: string;
        reviewedAt?: string;
        reviewedByAdminId?: string;
        reviewFeedback?: string;
        supersededAt?: string;
        fileUrl: string;
        isCurrent: boolean;
        isApproved: boolean;
        isDelivered: boolean;
    }>;
};

export default function WriterSubmissionReviewPage({ params }: { params: Promise<{ id: string }> }) {
    const router = useRouter();
    const [orderId, setOrderId] = useState('');
    const [data, setData] = useState<ReviewPageData | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    useEffect(() => { void params.then(({ id }) => setOrderId(id)); }, [params]);

    const loadReview = useCallback(async () => {
        if (!orderId) return;
        setLoading(true);
        try {
            const response = await fetch(`/api/admin/submissions/${encodeURIComponent(orderId)}`, { cache: 'no-store' });
            const result = await response.json();
            if (response.status === 401) { router.replace('/admin/login'); return; }
            if (!response.ok) throw new Error(result.error || 'Could not load review data');
            setData(result);
            setError('');
        } catch (reason: unknown) {
            setData(null);
            setError(reason instanceof Error ? reason.message : 'Could not load review data');
        } finally { setLoading(false); }
    }, [orderId, router]);

    useEffect(() => { void loadReview(); }, [loadReview]);

    const decide = async (decision: 'approved' | 'revision_required') => {
        if (!data?.currentSubmissionId || saving) return;
        if (decision === 'revision_required' && feedback.trim().length < 10) {
            setError('Provide at least 10 characters of revision feedback.');
            return;
        }
        setSaving(true);
        setError('');
        setNotice('');
        try {
            const response = await fetch(`/api/admin/submissions/${encodeURIComponent(orderId)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    submissionId: data.currentSubmissionId,
                    assignmentVersion: data.assignment.version,
                    decision,
                    ...(decision === 'revision_required' ? { feedback } : {}),
                }),
            });
            const result = await response.json();
            if (!response.ok) {
                await loadReview();
                throw new Error(result.error || 'Could not save the review decision');
            }
            await loadReview();
            setFeedback('');
            setNotice(decision === 'approved'
                ? 'Submission approved. The order is Completed, the approved file is available to the customer, and physical delivery is Pending.'
                : 'Revision request saved. The writer can submit a new version.');
        } catch (reason: unknown) {
            setError(reason instanceof Error ? reason.message : 'Could not save the review decision');
        } finally { setSaving(false); }
    };

    const currentSubmission = data?.submissions.find((submission) => submission.submissionId === data.currentSubmissionId);

    return <>
        <AdminNav />
        <main className="container admin-page admin-review-page">
            <p style={{ margin: '1rem 0' }}><Link className="btn btn-secondary" href="/admin/dashboard">← Back to dashboard</Link></p>
            {loading ? <div className="card"><div className="spinner" aria-label="Loading submission review" /></div> : error && !data ? (
                <div className="card"><div className="error-message" role="alert">{error}</div></div>
            ) : data && <>
                <section className="card admin-panel">
                    <div className="card-title-row">
                        <h1 style={{ margin: 0 }}>Review {data.order.orderId}</h1>
                        <span className="status-badge status-in-progress">{data.workflowStatus.replaceAll('_', ' ')}</span>
                    </div>
                    {error && <div className="error-message" role="alert">{error}</div>}
                    {notice && <div className="success-message" role="status">{notice}</div>}
                    <p><strong>Customer order status:</strong> {data.order.orderStatus} · <strong>Writer workflow:</strong> {data.workflowStatus.replaceAll('_', ' ')}</p>
                    <p><strong>Customer:</strong> {data.order.userName} · <strong>Academic context:</strong> {data.order.collegeName}, {data.order.yearOfStudying}, {data.order.branch}</p>
                    <section className="review-section">
                        <h2>Order requirements</h2>
                        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{data.order.instructions}</p>
                    </section>
                    {currentSubmission ? (
                        <section className="review-section" aria-labelledby="current-submission-heading">
                            <h2 id="current-submission-heading">Current submission</h2>
                            <p><strong>Writer:</strong> {currentSubmission.writer.name} · {currentSubmission.writer.email}</p>
                            <p><strong>Assignment:</strong> version {currentSubmission.assignmentVersion} · <strong>Submitted:</strong> {new Date(currentSubmission.submittedAt).toLocaleString('en-IN')}</p>
                            <p><a className="btn btn-secondary" href={currentSubmission.fileUrl} target="_blank" rel="noopener noreferrer">Open submitted file</a></p>
                            {currentSubmission.reviewStatus === 'pending_review' && data.workflowStatus === 'submitted_for_review' && (
                                <div>
                                    <div className="form-group">
                                        <label htmlFor="revision-feedback">Revision feedback (required for revision requests; 10–2000 characters)</label>
                                        <textarea id="revision-feedback" value={feedback} maxLength={2000} disabled={saving} onChange={(event) => setFeedback(event.target.value)} />
                                    </div>
                                    <div className="responsive-actions">
                                        <button className="btn btn-success" disabled={saving} onClick={() => void decide('approved')}>{saving ? 'Saving decision...' : 'Approve submission'}</button>
                                        <button className="btn btn-primary" disabled={saving || feedback.trim().length < 10} onClick={() => void decide('revision_required')}>{saving ? 'Saving decision...' : 'Request revisions'}</button>
                                    </div>
                                </div>
                            )}
                        </section>
                    ) : <p>No current submission is awaiting review. Refresh the queue or inspect the history below.</p>}
                    <section className="review-section">
                        <h2>Submission history</h2>
                        {data.submissions.length === 0 ? <p>No submissions have been recorded.</p> : (
                            <ol style={{ paddingLeft: '1.25rem' }}>
                                {data.submissions.map((submission) => (
                                    <li key={submission.submissionId} style={{ marginBottom: '1rem' }}>
                                        <p>
                                            {submission.writer.name} · assignment {submission.assignmentVersion} · {new Date(submission.submittedAt).toLocaleString('en-IN')} · <strong>{submission.reviewStatus.replaceAll('_', ' ')}</strong>
                                            {submission.isCurrent ? ' · current' : ''}{submission.isApproved ? ' · approved file' : ''}{submission.isDelivered ? ' · delivered to customer' : ''}
                                            {submission.supersededAt ? ` · superseded ${new Date(submission.supersededAt).toLocaleString('en-IN')}` : ''}
                                        </p>
                                        <p><a href={submission.fileUrl} target="_blank" rel="noopener noreferrer">Open this submission</a></p>
                                        {submission.reviewedAt && <p>Reviewed {new Date(submission.reviewedAt).toLocaleString('en-IN')} by admin {submission.reviewedByAdminId || 'unknown'}</p>}
                                        {submission.reviewFeedback && <p><strong>Revision feedback:</strong> {submission.reviewFeedback}</p>}
                                    </li>
                                ))}
                            </ol>
                        )}
                    </section>
                    <p style={{ color: '#6b7280' }}>
                        {data.submissions.some((submission) => submission.isDelivered)
                            ? 'The approved submission is the customer delivery file. The order is Completed; use the existing order details action to confirm physical delivery when it has been sent.'
                            : 'Approving the current submission completes the order and makes the approved file available to the customer. Physical delivery remains Pending until confirmed from the order details page.'}
                    </p>
                </section>
            </>}
        </main>
    </>;
}
