'use client';

import BrandMark from '@/components/BrandMark';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type AssignmentDetail = {
    order: {
        orderId: string;
        orderStatus: string;
        collegeName: string;
        yearOfStudying: string;
        branch: string;
        instructions: string;
        createdDate: string;
    };
    assignment: {
        status: 'pending_acceptance' | 'accepted';
        assignedAt?: string;
        responseDeadline?: string;
        respondedAt?: string;
        version: number;
    };
    writerWorkflowStatus: 'not_started' | 'assigned' | 'submitted_for_review' | 'revision_required' | 'approved';
    currentSubmissionId: string | null;
    submissions: Array<{
        submissionId: string;
        submittedAt: string;
        reviewStatus: 'pending_review' | 'revision_required' | 'approved';
        reviewedAt?: string;
        reviewFeedback?: string;
        isCurrent: boolean;
        fileUrl: string;
    }>;
    referenceFiles: Array<{
        id: string;
        filename: string;
        contentType?: string;
        size?: number;
        uploadDate?: string;
        downloadUrl?: string;
        available: boolean;
    }>;
    referenceFileCount: number;
};

export default function WriterOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const router = useRouter();
    const [orderId, setOrderId] = useState('');
    const [detail, setDetail] = useState<AssignmentDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [responding, setResponding] = useState(false);
    const [submissionFile, setSubmissionFile] = useState<File | null>(null);
    const [submissionFileError, setSubmissionFileError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        void params.then(({ id }) => setOrderId(id));
    }, [params]);

    const loadDetail = useCallback(async (showLoading = false) => {
        if (!orderId) return;
        if (showLoading) setLoading(true);
        try {
            const response = await fetch(`/api/writer/orders/${encodeURIComponent(orderId)}`, { cache: 'no-store' });
            const result = await response.json();
            if (response.status === 401) {
                router.replace('/writer/login');
                return;
            }
            if (!response.ok) throw new Error(result.error || 'Could not load this assignment');
            setDetail(result);
            setError('');
        } catch (reason: unknown) {
            setDetail(null);
            setError(reason instanceof Error ? reason.message : 'Could not load this assignment');
        } finally {
            setLoading(false);
        }
    }, [orderId, router]);

    useEffect(() => {
        void loadDetail(true);
    }, [loadDetail]);

    useEffect(() => {
        if (!orderId) return;
        const refreshVisibleDetail = () => {
            if (document.visibilityState === 'visible') void loadDetail();
        };
        const timer = window.setInterval(refreshVisibleDetail, 30_000);
        window.addEventListener('focus', refreshVisibleDetail);
        document.addEventListener('visibilitychange', refreshVisibleDetail);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', refreshVisibleDetail);
            document.removeEventListener('visibilitychange', refreshVisibleDetail);
        };
    }, [loadDetail, orderId]);

    const respond = async (decision: 'accepted' | 'declined') => {
        if (!detail || responding || detail.assignment.status !== 'pending_acceptance') return;
        setResponding(true);
        setNotice('');
        setError('');
        try {
            const response = await fetch(`/api/writer/orders/${encodeURIComponent(orderId)}/assignment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision, assignmentVersion: detail.assignment.version }),
            });
            const result = await response.json();
            if (!response.ok) {
                await loadDetail();
                throw new Error(result.error || 'This assignment changed. The latest state has been loaded.');
            }
            if (decision === 'declined') {
                router.replace('/writer/dashboard');
                router.refresh();
                return;
            }
            setNotice('Assignment accepted. Reference files are now available below.');
            await loadDetail();
        } catch (reason: unknown) {
            setError(reason instanceof Error ? reason.message : 'Could not update assignment');
        } finally {
            setResponding(false);
        }
    };

    const submitWork = async () => {
        if (!detail || !submissionFile || submitting || detail.assignment.status !== 'accepted') return;
        setSubmitting(true);
        setError('');
        setNotice('');
        try {
            const formData = new FormData();
            formData.append('assignmentVersion', String(detail.assignment.version));
            formData.append('submissionFile', submissionFile);
            const response = await fetch(`/api/writer/orders/${encodeURIComponent(orderId)}/submission`, {
                method: 'POST',
                body: formData,
            });
            const responseText = await response.text();
            let result: { error?: unknown } | null = null;
            try {
                result = JSON.parse(responseText) as { error?: unknown };
            } catch {
                // Proxies and hosting layers can return non-JSON errors (for example, request-size failures).
            }
            if (!response.ok) {
                await loadDetail();
                const message = typeof result?.error === 'string'
                    ? result.error
                    : `The upload request failed (HTTP ${response.status}).`;
                throw new Error(message);
            }
            if (!result) {
                await loadDetail();
                throw new Error(`The upload response could not be read (HTTP ${response.status}). Check submission history before retrying.`);
            }
            setSubmissionFile(null);
            setSubmissionFileError('');
            const input = document.getElementById('writer-submission-file') as HTMLInputElement | null;
            if (input) input.value = '';
            await loadDetail();
            setNotice('Your work was submitted for admin review. The customer order status has not changed.');
        } catch (reason: unknown) {
            setError(reason instanceof Error ? reason.message : 'Could not submit work');
        } finally {
            setSubmitting(false);
        }
    };

    const selectSubmissionFile = (file: File | undefined) => {
        if (!file) return;
        const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        const allowedTypes: Record<string, string> = {
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.ppt': 'application/vnd.ms-powerpoint',
            '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        };
        if (file.size > 25 * 1024 * 1024) {
            setSubmissionFile(null);
            setSubmissionFileError('The file exceeds the 25 MiB limit. Choose a smaller file.');
            return;
        }
        if (!allowedTypes[extension] || file.type !== allowedTypes[extension]) {
            setSubmissionFile(null);
            setSubmissionFileError('Choose a PDF, Word, or PowerPoint file with a matching file type.');
            return;
        }
        setSubmissionFile(file);
        setSubmissionFileError('');
    };

    const sizeLabel = (bytes?: number) => {
        if (bytes === undefined) return 'Size unavailable';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return <>
        <header className="header">
            <div className="header-content">
                <BrandMark />
                <nav><Link href="/writer/dashboard">Writer dashboard</Link></nav>
            </div>
        </header>
        <main className="container writer-detail-page">
            <p className="writer-detail-back"><Link className="btn btn-secondary" href="/writer/dashboard">← Back to workspace</Link></p>
            {loading ? <div className="card"><div className="spinner" aria-label="Loading assignment details" /></div> : error && !detail ? (
                <div className="card"><div className="error-message" role="alert">{error}</div></div>
            ) : detail && <>
                <section className="card writer-detail-card">
                    <div className="writer-detail-title">
                        <div><p className="writer-workspace__eyebrow">ASSIGNMENT DETAILS</p><h1>Assignment {detail.order.orderId}</h1></div>
                        <span className={`writer-pill ${detail.assignment.status === 'pending_acceptance' ? 'writer-pill--pending' : 'writer-pill--active'}`}>{detail.assignment.status === 'pending_acceptance' ? 'Awaiting response' : 'Accepted'}</span>
                    </div>
                    {error && <div className="error-message" role="alert">{error}</div>}
                    {notice && <div className="success-message" role="status">{notice}</div>}
                    <div className="review-section writer-detail-section">
                        <h2>Order details</h2>
                        <p><strong>Academic context:</strong> {detail.order.collegeName} · {detail.order.yearOfStudying} · {detail.order.branch}</p>
                        <p><strong>Order status:</strong> {detail.order.orderStatus}</p>
                        <p><strong>Submitted:</strong> {new Date(detail.order.createdDate).toLocaleString('en-IN')}</p>
                        <p><strong>Assigned:</strong> {detail.assignment.assignedAt ? new Date(detail.assignment.assignedAt).toLocaleString('en-IN') : 'Date unavailable'}</p>
                        {detail.assignment.status === 'pending_acceptance' && detail.assignment.responseDeadline && (
                            <p><strong>Accept or decline by:</strong> {new Date(detail.assignment.responseDeadline).toLocaleString('en-IN')}</p>
                        )}
                        {detail.assignment.status === 'accepted' && detail.assignment.respondedAt && (
                            <p><strong>Accepted:</strong> {new Date(detail.assignment.respondedAt).toLocaleString('en-IN')}</p>
                        )}
                    </div>
                    <div className="review-section writer-detail-section">
                        <h2>Requirements and instructions</h2>
                        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{detail.order.instructions || 'No instructions were recorded.'}</p>
                    </div>
                    <div className="review-section writer-detail-section">
                        <h2>Customer reference files</h2>
                        {detail.assignment.status !== 'accepted' ? (
                            <p>Accept this assignment before downloading its reference files. The files are not accessible while awaiting your response.</p>
                        ) : detail.referenceFiles.length === 0 ? (
                            <p>No customer reference files are attached.</p>
                        ) : (
                            <ul style={{ paddingLeft: '1.25rem' }}>
                                {detail.referenceFiles.map((file) => (
                                    <li key={file.id} style={{ marginBottom: '0.75rem', overflowWrap: 'anywhere' }}>
                                        <strong>{file.filename}</strong> · {sizeLabel(file.size)}
                                        {file.contentType && <span> · {file.contentType}</span>}
                                        {file.available && file.downloadUrl ? (
                                            <> · <a href={file.downloadUrl} target="_blank" rel="noopener noreferrer">Download reference file</a></>
                                        ) : <span> · File is unavailable</span>}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="review-section writer-detail-section">
                        <h2>Work status</h2>
                        <p>Current order lifecycle status: <strong>{detail.order.orderStatus}</strong>.</p>
                        <p>Internal review status: <strong>{detail.writerWorkflowStatus.replaceAll('_', ' ')}</strong>. This does not change the customer-facing order status.</p>
                        {detail.assignment.status === 'pending_acceptance' && (
                            <p role="status">Accept this assignment before uploading completed work. Use the Accept assignment button below; the submission form will become available after acceptance.</p>
                        )}
                        {detail.assignment.status === 'accepted' && detail.order.orderStatus !== 'Completed' && ['assigned', 'not_started', 'revision_required'].includes(detail.writerWorkflowStatus) && (
                            <div className="form-group" aria-labelledby="submission-label">
                                <h3 id="submission-label">Submit completed work</h3>
                                {detail.writerWorkflowStatus === 'revision_required' && (
                                    <p className="error-message">Revisions were requested. Review the admin feedback below before submitting a new version.</p>
                                )}
                                <label htmlFor="writer-submission-file">Submission file (PDF, Word, or PowerPoint; maximum 25 MiB)</label>
                                <input
                                    id="writer-submission-file"
                                    type="file"
                                    accept=".pdf,.doc,.docx,.ppt,.pptx"
                                    disabled={submitting}
                                    onChange={(event) => selectSubmissionFile(event.target.files?.[0])}
                                />
                                {submissionFile && <p>Selected file: <strong>{submissionFile.name}</strong></p>}
                                {submissionFileError && <p className="error-message" role="alert">{submissionFileError}</p>}
                                <button className="btn btn-primary" disabled={!submissionFile || submitting} onClick={() => void submitWork()}>
                                    {submitting ? 'Uploading and submitting...' : 'Submit for admin review'}
                                </button>
                                {!submissionFile && <p>Select a file to enable submission.</p>}
                            </div>
                        )}
                        {detail.assignment.status === 'accepted' && (detail.order.orderStatus === 'Completed' || !['assigned', 'not_started', 'revision_required'].includes(detail.writerWorkflowStatus)) && (
                            <p>Submission is unavailable while this order is {detail.order.orderStatus === 'Completed' ? 'completed' : detail.writerWorkflowStatus.replaceAll('_', ' ')}.</p>
                        )}
                        <h3>Submission history</h3>
                        {detail.submissions.length === 0 ? <p>No submissions have been recorded for this assignment.</p> : (
                            <ol style={{ paddingLeft: '1.25rem' }}>
                                {detail.submissions.map((submission) => (
                                    <li key={submission.submissionId} style={{ marginBottom: '1rem' }}>
                                        <p>
                                            Submitted {new Date(submission.submittedAt).toLocaleString('en-IN')} · <strong>{submission.reviewStatus.replaceAll('_', ' ')}</strong>
                                            {submission.isCurrent ? ' · current' : ''}
                                            {submission.reviewedAt ? ` · reviewed ${new Date(submission.reviewedAt).toLocaleString('en-IN')}` : ''}
                                        </p>
                                        <a href={submission.fileUrl} target="_blank" rel="noopener noreferrer">Download my submission</a>
                                        {submission.reviewFeedback && <p><strong>Admin revision feedback:</strong> {submission.reviewFeedback}</p>}
                                    </li>
                                ))}
                            </ol>
                        )}
                    </div>
                    {detail.assignment.status === 'pending_acceptance' && (
                        <div className="responsive-actions">
                            <button className="btn btn-success" disabled={responding} onClick={() => void respond('accepted')}>{responding ? 'Saving...' : 'Accept assignment'}</button>
                            <button className="btn btn-secondary" disabled={responding} onClick={() => void respond('declined')}>Decline assignment</button>
                        </div>
                    )}
                </section>
            </>}
        </main>
    </>;
}
