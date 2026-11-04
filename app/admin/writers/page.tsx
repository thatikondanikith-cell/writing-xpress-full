'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import AdminNav from '@/app/admin/AdminNav';

type WriterStatus = 'pending' | 'approved' | 'rejected';
type WriterApplication = {
    id: string;
    name: string;
    email: string;
    createdAt: string;
    applicationStatus: WriterStatus;
    applicationReviewedAt?: string;
    rejectionReason?: string;
};
type WriterOverview = {
    id: string;
    name: string;
    email: string;
    applicationStatus: WriterStatus;
    isAvailable: boolean;
    activeOrderCount: number;
    activeOrderIds: string[];
    pendingAcceptanceCount: number;
    pendingAssignments: Array<{ orderId: string; responseDeadline?: string }>;
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
        onTimeCompletionRate: number | null;
    };
};
type Tab = 'writers' | 'applications' | 'performance';

const metricValue = (rate: number | null, numerator: number, denominator: number) =>
    rate === null ? 'Not enough data' : `${rate.toFixed(1)}% (${numerator}/${denominator})`;

export default function WriterManagementPage() {
    const [tab, setTab] = useState<Tab>('writers');
    const [applications, setApplications] = useState<WriterApplication[]>([]);
    const [writers, setWriters] = useState<WriterOverview[]>([]);
    const [loadingApplications, setLoadingApplications] = useState(true);
    const [loadingWriters, setLoadingWriters] = useState(true);
    const [applicationError, setApplicationError] = useState('');
    const [writerError, setWriterError] = useState('');
    const [reviewNotice, setReviewNotice] = useState('');
    const [reviewingId, setReviewingId] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [availability, setAvailability] = useState('all');
    const [workload, setWorkload] = useState('all');
    const [ratingFilter, setRatingFilter] = useState('all');
    const [sort, setSort] = useState('name');
    const [selectedWriterId, setSelectedWriterId] = useState<string | null>(null);
    const applicationRequestId = useRef(0);
    const writerRequestId = useRef(0);

    const fetchApplications = useCallback(async (showLoading = true) => {
        const requestId = ++applicationRequestId.current;
        if (showLoading) setLoadingApplications(true);
        try {
            const response = await fetch('/api/admin/writer-applications', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not load writer applications');
            if (requestId === applicationRequestId.current) {
                setApplications(data);
                setApplicationError('');
            }
        } catch (error) {
            if (requestId === applicationRequestId.current) setApplicationError(error instanceof Error ? error.message : 'Could not load writer applications');
        } finally {
            if (requestId === applicationRequestId.current) setLoadingApplications(false);
        }
    }, []);

    const fetchWriters = useCallback(async (showLoading = true) => {
        const requestId = ++writerRequestId.current;
        if (showLoading) setLoadingWriters(true);
        try {
            const response = await fetch('/api/admin/writer-overview', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not load writer overview');
            if (requestId === writerRequestId.current) {
                setWriters(data);
                setWriterError('');
            }
        } catch (error) {
            if (requestId === writerRequestId.current) setWriterError(error instanceof Error ? error.message : 'Could not load writer overview');
        } finally {
            if (requestId === writerRequestId.current) setLoadingWriters(false);
        }
    }, []);

    const refreshData = useCallback((showLoading = false) => {
        return Promise.all([fetchApplications(showLoading), fetchWriters(showLoading)]);
    }, [fetchApplications, fetchWriters]);

    useEffect(() => {
        void refreshData(true);
        let lastEventRefresh = 0;
        const refreshVisibleWriters = () => {
            if (document.visibilityState !== 'visible') return;
            if (Date.now() - lastEventRefresh < 1_000) return;
            lastEventRefresh = Date.now();
            void refreshData();
        };
        const timer = window.setInterval(refreshVisibleWriters, 30_000);
        window.addEventListener('focus', refreshVisibleWriters);
        document.addEventListener('visibilitychange', refreshVisibleWriters);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', refreshVisibleWriters);
            document.removeEventListener('visibilitychange', refreshVisibleWriters);
        };
    }, [refreshData]);

    const pendingApplications = applications.filter((application) => application.applicationStatus === 'pending');
    const approvedWriters = writers.filter((writer) => writer.applicationStatus === 'approved');
    const availableWriters = approvedWriters.filter((writer) => writer.isAvailable);
    const activeWriters = approvedWriters.filter((writer) => writer.activeOrderCount > 0);
    const selectedWriter = approvedWriters.find((writer) => writer.id === selectedWriterId) || null;

    const visibleWriters = useMemo(() => {
        const query = search.trim().toLowerCase();
        return approvedWriters
            .filter((writer) => !query || `${writer.name} ${writer.email}`.toLowerCase().includes(query))
            .filter((writer) => availability === 'all' || (availability === 'available') === writer.isAvailable)
            .filter((writer) => workload === 'all' || (workload === 'active') === (writer.activeOrderCount > 0))
            .filter((writer) => {
                if (ratingFilter === 'all') return true;
                if (ratingFilter === 'unrated') return writer.performance.reviewCount === 0;
                const minimum = Number(ratingFilter);
                return writer.performance.reviewCount > 0 && writer.performance.rating >= minimum;
            })
            .sort((left, right) => {
                if (sort === 'rating-desc' || sort === 'rating-asc') {
                    const leftHasRating = left.performance.reviewCount > 0;
                    const rightHasRating = right.performance.reviewCount > 0;
                    if (leftHasRating !== rightHasRating) return leftHasRating ? -1 : 1;
                    if (!leftHasRating) return 0;
                    return sort === 'rating-desc'
                        ? right.performance.rating - left.performance.rating
                        : left.performance.rating - right.performance.rating;
                }
                if (sort === 'workload-desc') return right.activeOrderCount - left.activeOrderCount;
                if (sort === 'workload-asc') return left.activeOrderCount - right.activeOrderCount;
                return left.name.localeCompare(right.name);
            });
    }, [approvedWriters, availability, ratingFilter, search, sort, workload]);

    const reviewApplication = async (application: WriterApplication, decision: 'approved' | 'rejected') => {
        if (!window.confirm(`${decision === 'approved' ? 'Approve' : 'Reject'} ${application.name}'s writer application?`)) return;
        let reason: string | undefined;
        if (decision === 'rejected') {
            const enteredReason = window.prompt('Optional note for the applicant (500 characters maximum):');
            if (enteredReason === null) return;
            reason = enteredReason;
        }

        setReviewingId(application.id);
        setApplicationError('');
        setReviewNotice('');
        try {
            const response = await fetch(`/api/admin/writer-applications/${application.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision, ...(decision === 'rejected' ? { reason } : {}) }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not review application');
            setReviewNotice(`${application.name}'s application was ${decision}.`);
            await refreshData();
        } catch (error) {
            setApplicationError(error instanceof Error ? error.message : 'Could not review application');
        } finally {
            setReviewingId(null);
        }
    };

    const refresh = () => void refreshData(true);
    const formatRate = (rate: number | null, n: number, d: number) => d === 0
        ? 'Not enough data'
        : metricValue(rate, n, d);

    return (
        <>
            <AdminNav />
            <main className="container admin-page writer-management">
                <div className="writer-page-heading">
                    <div>
                        <p className="writer-eyebrow">ADMINISTRATION</p>
                        <h1>Writer Management</h1>
                        <p>Review applications, monitor approved writers, and inspect performance.</p>
                        <p className="writer-refresh-note">Data refreshes on page focus and every 30 seconds.</p>
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={refresh}>Refresh data</button>
                </div>

                <section className="writer-summary-grid" aria-label="Writer summary">
                    <article className="writer-summary-card"><span>Approved writers</span><strong>{loadingWriters || writerError ? '—' : approvedWriters.length}</strong></article>
                    <article className="writer-summary-card"><span>Available now</span><strong>{loadingWriters || writerError ? '—' : availableWriters.length}</strong></article>
                    <article className="writer-summary-card"><span>Handling active orders</span><strong>{loadingWriters || writerError ? '—' : activeWriters.length}</strong></article>
                    <article className="writer-summary-card"><span>Pending applications</span><strong>{loadingApplications || applicationError ? '—' : pendingApplications.length}</strong></article>
                </section>
                {(writerError || applicationError) && <div className="error-message" role="alert">{[writerError, applicationError].filter(Boolean).join(' ')}</div>}

                <div className="writer-tabs" role="tablist" aria-label="Writer management sections">
                    {([
                        ['writers', `All Writers (${approvedWriters.length})`],
                        ['applications', `Applications (${pendingApplications.length})`],
                        ['performance', 'Performance'],
                    ] as const).map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            id={`writer-tab-${id}`}
                            aria-selected={tab === id}
                            aria-controls={`writer-panel-${id}`}
                            className={tab === id ? 'active' : ''}
                            onClick={() => setTab(id)}
                        >{label}</button>
                    ))}
                </div>

                {tab === 'writers' && <section role="tabpanel" id="writer-panel-writers" aria-labelledby="writer-tab-writers">
                    <div className="writer-filter-panel">
                        <label className="writer-search">Search writers
                            <input type="search" placeholder="Name or email" value={search} onChange={(event) => setSearch(event.target.value)} />
                        </label>
                        <label>Availability
                            <select value={availability} onChange={(event) => setAvailability(event.target.value)}>
                                <option value="all">Any status</option><option value="available">Available</option><option value="unavailable">Unavailable</option>
                            </select>
                        </label>
                        <label>Workload
                            <select value={workload} onChange={(event) => setWorkload(event.target.value)}>
                                <option value="all">Any workload</option><option value="active">Has active orders</option><option value="none">No active orders</option>
                            </select>
                        </label>
                        <label>Rating
                            <select value={ratingFilter} onChange={(event) => setRatingFilter(event.target.value)}>
                                <option value="all">Any rating</option><option value="4">4+ stars</option><option value="3">3+ stars</option><option value="unrated">No reviews</option>
                            </select>
                        </label>
                        <label>Sort by
                            <select value={sort} onChange={(event) => setSort(event.target.value)}>
                                <option value="name">Name</option><option value="rating-desc">Highest rating</option><option value="rating-asc">Lowest rating</option><option value="workload-desc">Most active orders</option><option value="workload-asc">Fewest active orders</option>
                            </select>
                        </label>
                    </div>
                    {writerError && <div className="error-message" role="alert">{writerError}</div>}
                    {loadingWriters ? <div className="card"><div className="spinner" aria-label="Loading writers" /></div> : visibleWriters.length === 0 ? (
                        <div className="card writer-empty"><h2>No writers match</h2><p>Try changing the search or filters.</p></div>
                    ) : <>
                        <div className="table-container writer-desktop-table">
                            <table className="writer-table">
                                <thead><tr><th>Writer</th><th>Availability</th><th>Active orders</th><th>Rating</th><th>Acceptance</th><th>Completion</th><th>Details</th></tr></thead>
                                <tbody>{visibleWriters.map((writer) => <tr key={writer.id}>
                                    <td><strong>{writer.name}</strong><small>{writer.email}</small></td>
                                    <td><span className={`writer-status ${writer.isAvailable ? 'available' : 'unavailable'}`}>{writer.isAvailable ? 'Available' : 'Unavailable'}</span></td>
                                    <td>{writer.activeOrderCount}<small>{writer.pendingAcceptanceCount} pending offers</small></td>
                                    <td>{writer.performance.reviewCount ? `${writer.performance.rating.toFixed(1)}${writer.performance.ratingIsProvisional ? ' provisional' : ''}` : 'No ratings'}<small>{writer.performance.reviewCount} reviews</small></td>
                                    <td>{formatRate(writer.performance.acceptanceRate, writer.performance.acceptedOffers, writer.performance.resolvedOffers)}</td>
                                    <td>{formatRate(writer.performance.completionRate, writer.performance.completedAcceptedAssignments, writer.performance.acceptedAssignments)}</td>
                                    <td><button className="writer-detail-button" type="button" aria-label={`View ${writer.name} details`} onClick={() => setSelectedWriterId(writer.id)}>View details</button></td>
                                </tr>)}</tbody>
                            </table>
                        </div>
                        <div className="writer-mobile-list">{visibleWriters.map((writer) => <article className="writer-mobile-card" key={writer.id}>
                            <div className="writer-mobile-card-heading"><div><h2>{writer.name}</h2><p>{writer.email}</p></div><span className={`writer-status ${writer.isAvailable ? 'available' : 'unavailable'}`}>{writer.isAvailable ? 'Available' : 'Unavailable'}</span></div>
                            <p>{writer.activeOrderCount} active orders · {writer.performance.reviewCount ? `${writer.performance.rating.toFixed(1)} rating` : 'No ratings'}</p>
                            <button className="writer-detail-button" type="button" aria-label={`View ${writer.name} details`} onClick={() => setSelectedWriterId(writer.id)}>View details</button>
                        </article>)}</div>
                    </>}
                    {selectedWriter && <section className="card writer-detail-panel" aria-labelledby="selected-writer-heading">
                        <div className="card-title-row"><div><p className="writer-eyebrow">WRITER DETAILS</p><h2 id="selected-writer-heading">{selectedWriter.name}</h2><p>{selectedWriter.email}</p></div><button type="button" className="btn btn-secondary" onClick={() => setSelectedWriterId(null)}>Close details</button></div>
                        <div className="writer-detail-grid">
                            <p><span>Availability</span><strong>{selectedWriter.isAvailable ? 'Available' : 'Unavailable'}</strong></p>
                            <p><span>Workload</span><strong>{selectedWriter.activeOrderCount} active orders</strong></p>
                            <p><span>Customer rating</span><strong>{selectedWriter.performance.reviewCount ? `${selectedWriter.performance.rating.toFixed(1)} / 5${selectedWriter.performance.ratingIsProvisional ? ' (provisional)' : ''}` : 'No reviews yet'}</strong></p>
                            <p><span>Reviews</span><strong>{selectedWriter.performance.reviewCount}</strong></p>
                            <p><span>Acceptance rate</span><strong>{formatRate(selectedWriter.performance.acceptanceRate, selectedWriter.performance.acceptedOffers, selectedWriter.performance.resolvedOffers)}</strong></p>
                            <p><span>Completion rate</span><strong>{formatRate(selectedWriter.performance.completionRate, selectedWriter.performance.completedAcceptedAssignments, selectedWriter.performance.acceptedAssignments)}</strong></p>
                            <p><span>On-time completion</span><strong>{selectedWriter.performance.onTimeCompletionRate === null ? 'Unavailable: no reliable deadline sample' : `${selectedWriter.performance.onTimeCompletionRate.toFixed(1)}%`}</strong></p>
                            <p><span>Pending offers</span><strong>{selectedWriter.pendingAcceptanceCount}</strong></p>
                        </div>
                        <h3>Active assignments</h3>
                        {selectedWriter.activeOrderIds.length === 0 ? <p>No active assignments.</p> : <ul className="writer-order-list">{selectedWriter.activeOrderIds.map((id) => <li key={id}><Link href={`/admin/order/${encodeURIComponent(id)}`}>{id}</Link></li>)}</ul>}
                        {selectedWriter.pendingAssignments.length > 0 && <>
                            <h3 style={{ marginTop: '1rem' }}>Pending offers</h3>
                            <ul className="writer-order-list">{selectedWriter.pendingAssignments.map((item) => <li key={item.orderId}><Link href={`/admin/order/${encodeURIComponent(item.orderId)}`}>{item.orderId}</Link>{item.responseDeadline && <> · due {new Date(item.responseDeadline).toLocaleString('en-IN')}</>}</li>)}</ul>
                        </>}
                    </section>}
                </section>}

                {tab === 'applications' && <section role="tabpanel" id="writer-panel-applications" aria-labelledby="writer-tab-applications">
                    {reviewNotice && <div className="success-message" role="status">{reviewNotice}</div>}
                    {applicationError && <div className="error-message" role="alert">{applicationError}</div>}
                    {loadingApplications ? <div className="card"><div className="spinner" aria-label="Loading applications" /></div> : pendingApplications.length === 0 ? (
                        <div className="card writer-empty"><h2>No pending applications</h2><p>New applications will appear here for review.</p></div>
                    ) : <div className="writer-applications-layout">
                        <div className="table-container writer-desktop-table">
                        <table className="writer-table">
                            <thead><tr><th>Applicant</th><th>Email</th><th>Applied</th><th>Status</th><th>Decision</th></tr></thead>
                            <tbody>{pendingApplications.map((application) => <tr key={application.id}>
                                <td><strong>{application.name}</strong></td><td>{application.email}</td>
                                <td>{new Date(application.createdAt).toLocaleDateString('en-IN')}</td>
                                <td><span className="writer-status pending">Pending</span></td>
                                <td><div className="writer-actions">
                                    <button className="btn btn-success" type="button" disabled={reviewingId === application.id} onClick={() => void reviewApplication(application, 'approved')}>{reviewingId === application.id ? 'Saving…' : 'Approve'}</button>
                                    <button className="btn btn-secondary" type="button" disabled={reviewingId === application.id} onClick={() => void reviewApplication(application, 'rejected')}>Reject</button>
                                </div></td>
                            </tr>)}</tbody>
                        </table>
                        </div>
                        <div className="writer-mobile-list">{pendingApplications.map((application) => <article className="writer-mobile-card" key={application.id}>
                            <div className="writer-mobile-card-heading"><div><h2>{application.name}</h2><p>{application.email}</p></div><span className="writer-status pending">Pending</span></div>
                            <p>Applied {new Date(application.createdAt).toLocaleDateString('en-IN')}</p>
                            <div className="writer-actions"><button className="btn btn-success" type="button" disabled={reviewingId === application.id} onClick={() => void reviewApplication(application, 'approved')}>Approve</button><button className="btn btn-secondary" type="button" disabled={reviewingId === application.id} onClick={() => void reviewApplication(application, 'rejected')}>Reject</button></div>
                        </article>)}</div>
                    </div>}
                </section>}

                {tab === 'performance' && <section role="tabpanel" id="writer-panel-performance" aria-labelledby="writer-tab-performance">
                    {writerError && <div className="error-message" role="alert">{writerError}</div>}
                    {loadingWriters ? <div className="card"><div className="spinner" aria-label="Loading writer performance" /></div> : approvedWriters.length === 0 ? (
                        <div className="card writer-empty"><h2>No performance data yet</h2><p>Approved writers will appear here after they begin receiving assignments.</p></div>
                    ) : <div className="writer-performance-grid">{approvedWriters.map((writer) => <article className="card writer-performance-card" key={writer.id}>
                        <div className="writer-mobile-card-heading"><div><h2>{writer.name}</h2><p>{writer.email}</p></div><button type="button" className="writer-detail-button" onClick={() => { setSelectedWriterId(writer.id); setTab('writers'); }}>Details</button></div>
                        <div className="writer-performance-metric"><span>Customer rating</span><strong>{writer.performance.reviewCount ? `${writer.performance.rating.toFixed(1)} / 5` : 'No reviews'}</strong><small>{writer.performance.reviewCount} {writer.performance.reviewCount === 1 ? 'review' : 'reviews'}{writer.performance.ratingIsProvisional ? ' · provisional' : ''}</small></div>
                        <div className="writer-performance-metric"><span>Offer acceptance</span><strong>{formatRate(writer.performance.acceptanceRate, writer.performance.acceptedOffers, writer.performance.resolvedOffers)}</strong><small>{writer.performance.resolvedOffers} resolved offers</small></div>
                        <div className="writer-performance-metric"><span>Assignment completion</span><strong>{formatRate(writer.performance.completionRate, writer.performance.completedAcceptedAssignments, writer.performance.acceptedAssignments)}</strong><small>{writer.performance.acceptedAssignments} accepted assignments</small></div>
                        <p className="writer-metric-note">Rates use the resolved assignment samples returned by the server. On-time completion is unavailable because the current data does not provide a reliable deadline sample.</p>
                    </article>)}</div>}
                </section>}
            </main>
        </>
    );
}
