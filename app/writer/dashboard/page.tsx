'use client';

import BrandMark from '@/components/BrandMark';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type ApplicationStatus = 'pending' | 'approved' | 'rejected';
type Application = {
    name: string;
    email: string;
    applicationStatus: ApplicationStatus;
    rejectionReason?: string;
};

type WriterWorkspaceOrder = {
    orderId: string;
    orderStatus: string;
    collegeName: string;
    yearOfStudying: string;
    branch: string;
    createdDate: string;
    assignedAt?: string;
    assignmentStatus?: 'pending_acceptance' | 'accepted';
    assignmentResponseDeadline?: string;
    assignmentRespondedAt?: string;
    assignmentVersion?: number;
    writerWorkflowStatus?: 'not_started' | 'assigned' | 'submitted_for_review' | 'revision_required' | 'approved';
};

type WriterWorkspace = {
    isAvailable: boolean;
    activeOrderCount: number;
    pendingAcceptanceCount: number;
    pendingAssignments: WriterWorkspaceOrder[];
    activeOrders: WriterWorkspaceOrder[];
    completedOrders: WriterWorkspaceOrder[];
    completedTotalCount: number;
    completedPage: number;
    completedLimit: number;
    completedTotalPages: number;
};

export default function WriterDashboardPage() {
    const router = useRouter();
    const [application, setApplication] = useState<Application | null>(null);
    const [error, setError] = useState('');
    const [workspace, setWorkspace] = useState<WriterWorkspace | null>(null);
    const [workspaceLoading, setWorkspaceLoading] = useState(false);
    const [availabilitySaving, setAvailabilitySaving] = useState(false);
    const [availabilityMessage, setAvailabilityMessage] = useState('');
    const [availabilityError, setAvailabilityError] = useState('');
    const [assignmentResponseError, setAssignmentResponseError] = useState('');
    const [assignmentResponseMessage, setAssignmentResponseMessage] = useState('');
    const [respondingOrderId, setRespondingOrderId] = useState<string | null>(null);
    const [currentTime, setCurrentTime] = useState(() => Date.now());
    const [assignmentSearch, setAssignmentSearch] = useState('');
    const [assignmentSort, setAssignmentSort] = useState<'newest' | 'oldest'>('newest');
    const [completedPage, setCompletedPage] = useState(1);
    const dashboardRequestId = useRef(0);
    const workspaceQueryRequestId = useRef(0);
    const availabilityWriteVersion = useRef(0);
    const availabilitySavingRef = useRef(false);
    const workspaceQueryRef = useRef({ completedPage, assignmentSearch, assignmentSort });
    workspaceQueryRef.current = { completedPage, assignmentSearch, assignmentSort };

    const fetchWorkspace = async (): Promise<WriterWorkspace | null> => {
        const requestId = ++workspaceQueryRequestId.current;
        const writeVersion = availabilityWriteVersion.current;
        const query = workspaceQueryRef.current;
        const params = new URLSearchParams({
            completedPage: String(query.completedPage),
            completedLimit: '10',
            search: query.assignmentSearch.trim(),
            sort: query.assignmentSort,
        });
        const response = await fetch(`/api/writer/workspace?${params.toString()}`, { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load assignments');
        if (requestId !== workspaceQueryRequestId.current || writeVersion !== availabilityWriteVersion.current) return null;
        setWorkspace(result);
        return result as WriterWorkspace;
    };

    useEffect(() => {
        const clock = window.setInterval(() => setCurrentTime(Date.now()), 1000);
        return () => window.clearInterval(clock);
    }, []);

    useEffect(() => {
        const loadDashboard = async () => {
            const requestId = ++dashboardRequestId.current;
            const writeVersion = availabilityWriteVersion.current;
            try {
                const response = await fetch('/api/writer/application', { cache: 'no-store' });
                const result = await response.json();
                if (response.status === 401) {
                    router.replace('/writer/login');
                    return;
                }
                if (!response.ok) throw new Error(result.error || 'Could not load application');
                if (requestId !== dashboardRequestId.current) return;
                setApplication(result);
                if (result.applicationStatus === 'approved') {
                    setWorkspaceLoading(true);
                    const workspaceResult = await fetchWorkspace();
                    if (requestId === dashboardRequestId.current && writeVersion === availabilityWriteVersion.current && workspaceResult) {
                        setError('');
                    }
                } else {
                    if (requestId === dashboardRequestId.current) setWorkspace(null);
                }
            } catch (reason: unknown) {
                if (requestId === dashboardRequestId.current) {
                    setError(reason instanceof Error ? reason.message : 'Could not load application');
                }
            } finally {
                if (requestId === dashboardRequestId.current) setWorkspaceLoading(false);
            }
        };
        void loadDashboard();
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void loadDashboard();
        }, 30_000);
        const refreshVisibleDashboard = () => {
            if (document.visibilityState === 'visible') void loadDashboard();
        };
        window.addEventListener('focus', refreshVisibleDashboard);
        document.addEventListener('visibilitychange', refreshVisibleDashboard);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', refreshVisibleDashboard);
            document.removeEventListener('visibilitychange', refreshVisibleDashboard);
        };
    }, [router]);

    useEffect(() => {
        if (application?.applicationStatus !== 'approved') return;
        const timeout = window.setTimeout(() => {
            void fetchWorkspace().catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : 'Could not load completed history');
            });
        }, assignmentSearch ? 250 : 0);
        return () => window.clearTimeout(timeout);
    }, [completedPage, assignmentSearch, assignmentSort]);

    const changeAvailability = async (isAvailable: boolean) => {
        if (availabilitySavingRef.current) return;
        availabilitySavingRef.current = true;
        setAvailabilitySaving(true);
        setAvailabilityError('');
        setAvailabilityMessage('');
        try {
            const response = await fetch('/api/writer/availability', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isAvailable }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not update availability');
            availabilityWriteVersion.current += 1;
            dashboardRequestId.current += 1;
            workspaceQueryRequestId.current += 1;
            setWorkspace((current) => current ? { ...current, isAvailable: result.isAvailable } : current);
            setAvailabilityMessage(`Availability set to ${result.isAvailable ? 'Available' : 'Unavailable'}.`);
        } catch (reason: unknown) {
            setAvailabilityError(reason instanceof Error ? reason.message : 'Could not update availability');
        } finally {
            availabilitySavingRef.current = false;
            setAvailabilitySaving(false);
        }
    };

    const respondToAssignment = async (order: WriterWorkspaceOrder, decision: 'accepted' | 'declined') => {
        if (respondingOrderId || !Number.isSafeInteger(order.assignmentVersion)) return;
        setRespondingOrderId(order.orderId);
        setAssignmentResponseError('');
        setAssignmentResponseMessage('');
        try {
            const response = await fetch(`/api/writer/orders/${encodeURIComponent(order.orderId)}/assignment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision, assignmentVersion: order.assignmentVersion }),
            });
            const result = await response.json();
            if (!response.ok) {
                if (response.status === 409 || response.status === 410) {
                    await fetchWorkspace();
                }
                throw new Error(result.error || 'Could not update assignment');
            }
            const updatedWorkspace = await fetchWorkspace();
            if (!updatedWorkspace) throw new Error('Response saved, but workspace refresh was superseded.');
            setAssignmentResponseMessage(decision === 'accepted'
                ? `You accepted ${order.orderId}.`
                : `You declined ${order.orderId}; it is back in the admin assignment queue.`);
        } catch (reason: unknown) {
            setAssignmentResponseError(reason instanceof Error ? reason.message : 'Could not update assignment');
        } finally {
            setRespondingOrderId(null);
        }
    };

    const countdown = (deadline?: string) => {
        if (!deadline) return 'Deadline unavailable';
        const remaining = Math.max(0, Date.parse(deadline) - currentTime);
        const minutes = Math.floor(remaining / 60_000);
        const seconds = Math.floor((remaining % 60_000) / 1000);
        return remaining === 0 ? 'Deadline passed — refreshing assignment state' : `${minutes}:${String(seconds).padStart(2, '0')} remaining`;
    };

    const responseDeadlinePassed = (deadline?: string) => {
        if (!deadline) return true;
        const parsed = Date.parse(deadline);
        return !Number.isFinite(parsed) || currentTime >= parsed;
    };

    const assignmentsFor = (orders: WriterWorkspaceOrder[]) => {
        const query = assignmentSearch.trim().toLowerCase();
        return orders
            .filter((order) => !query || [order.orderId, order.collegeName, order.yearOfStudying, order.branch]
                .some((value) => value.toLowerCase().includes(query)))
            .sort((a, b) => {
                const aDate = Date.parse(a.assignedAt || a.createdDate);
                const bDate = Date.parse(b.assignedAt || b.createdDate);
                return assignmentSort === 'newest' ? bDate - aDate : aDate - bDate;
            });
    };

    const handleLogout = async () => {
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST' });
            if (!response.ok) {
                setError('Logout failed. Please try again.');
                return;
            }
            router.replace('/writer/login');
            router.refresh();
        } catch {
            setError('Logout failed. Please try again.');
        }
    };

    const heading = application?.applicationStatus === 'approved'
        ? 'Approved'
        : application?.applicationStatus === 'rejected'
            ? 'Rejected'
            : 'Pending Verification';
    const pendingAssignments = assignmentsFor(workspace?.pendingAssignments || []);
    const activeOrders = assignmentsFor(workspace?.activeOrders || []);
    const assignmentCards = (orders: WriterWorkspaceOrder[], category: 'pending' | 'active' | 'completed') => orders.map((order) => (
        <article key={order.orderId} className={`writer-assignment-card writer-assignment-card--${category}`}>
            <div className="writer-assignment-card__top">
                <h3>{order.orderId}</h3>
                <span className={`writer-pill writer-pill--${category}`}>{category === 'pending' ? 'Awaiting response' : category === 'active' ? 'Active work' : 'Completed'}</span>
            </div>
            <p className="writer-assignment-card__school">{order.collegeName}</p>
            <p className="writer-assignment-card__context">Year {order.yearOfStudying} <span aria-hidden="true">·</span> {order.branch}</p>
            <div className="writer-assignment-card__meta">
                <p><span>Order status</span><strong>{order.orderStatus}</strong></p>
                {category !== 'pending' && <p><span>Internal review</span><strong>{(order.writerWorkflowStatus || 'assigned').replaceAll('_', ' ')}</strong></p>}
                <p><span>{category === 'pending' ? 'Assigned' : 'Assignment date'}</span><strong>{order.assignmentRespondedAt ? new Date(order.assignmentRespondedAt).toLocaleDateString('en-IN') : order.assignedAt ? new Date(order.assignedAt).toLocaleDateString('en-IN') : 'Date unavailable'}</strong></p>
                {category === 'pending' && <p className="writer-assignment-card__deadline"><span>Respond by</span><strong>{order.assignmentResponseDeadline ? new Date(order.assignmentResponseDeadline).toLocaleString('en-IN') : 'Deadline unavailable'} · {countdown(order.assignmentResponseDeadline)}</strong></p>}
            </div>
            <div className="writer-assignment-card__actions">
                <Link className="btn btn-secondary writer-assignment-details-link" href={`/writer/order/${encodeURIComponent(order.orderId)}`}>View assignment details</Link>
                {category === 'pending' && <>
                    <button className="btn btn-success" disabled={respondingOrderId !== null || responseDeadlinePassed(order.assignmentResponseDeadline) || !Number.isSafeInteger(order.assignmentVersion)} onClick={() => void respondToAssignment(order, 'accepted')}>
                        {respondingOrderId === order.orderId ? 'Saving...' : 'Accept'}
                    </button>
                    <button className="btn btn-secondary" disabled={respondingOrderId !== null || responseDeadlinePassed(order.assignmentResponseDeadline) || !Number.isSafeInteger(order.assignmentVersion)} onClick={() => void respondToAssignment(order, 'declined')}>Decline</button>
                </>}
            </div>
        </article>
    ));

    return (
        <>
            <header className="header writer-header">
                <div className="header-content">
                    <BrandMark />
                    <nav>
                        {application && <span style={{ color: '#6B7280' }}>{application.name}</span>}
                        <button onClick={handleLogout} className="btn btn-secondary">Logout</button>
                    </nav>
                </div>
            </header>
            <main className="container writer-workspace">
                <div className="writer-workspace__heading">
                    <div><p className="writer-workspace__eyebrow">WRITER WORKSPACE</p><h1>Writer dashboard</h1><p>Manage your assignments, availability and submission history.</p></div>
                    {application && <span className={`writer-pill writer-pill--application-${application.applicationStatus}`}>{heading}</span>}
                </div>
                <div className="writer-workspace__body">
                    {error && <div className="error-message">{error}</div>}
                    {!application && !error ? <div className="spinner" /> : application && (
                        <>
                            {application.applicationStatus === 'pending' && (
                                <section className="writer-notice"><h2>Application under review</h2><p>Your application is waiting for admin verification. Writer features and order assignments become available after approval.</p></section>
                            )}
                            {application.applicationStatus === 'approved' && (
                                <>
                                    {workspaceLoading ? <div className="spinner" /> : workspace && (
                                        <>
                                            <section className="writer-overview" aria-label="Writer workload">
                                                <div className="writer-overview__intro"><div><p className="writer-workspace__eyebrow">YOUR OVERVIEW</p><h2>Availability and workload</h2><p>Availability only affects eligibility for new assignments. Existing assignments remain unchanged.</p></div><button className={`btn ${workspace.isAvailable ? 'btn-secondary' : 'btn-success'}`} disabled={availabilitySaving} onClick={() => changeAvailability(!workspace.isAvailable)}>{availabilitySaving ? 'Saving...' : `Set ${workspace.isAvailable ? 'Unavailable' : 'Available'}`}</button></div>
                                                <div className="writer-overview__grid">
                                                    <div className="writer-overview-card"><span>Availability</span><strong className="writer-overview-card__state">{workspace.isAvailable ? 'Available' : 'Unavailable'}</strong><small>New assignment eligibility</small></div>
                                                    <div className="writer-overview-card"><span>Awaiting response</span><strong>{workspace.pendingAcceptanceCount}</strong><small>Assignments needing your decision</small></div>
                                                    <div className="writer-overview-card"><span>Accepted active work</span><strong>{workspace.activeOrderCount}</strong><small>Current workload</small></div>
                                                </div>
                                                {availabilityMessage && <div className="success-message" role="status">{availabilityMessage}</div>}
                                                {availabilityError && <div className="error-message" role="alert">{availabilityError}</div>}
                                            </section>
                                            <div className="writer-assignment-heading"><div><p className="writer-workspace__eyebrow">ASSIGNMENTS</p><h2>Manage your work</h2><p>Submit work and review revision feedback from each assignment. Internal review does not change the customer-facing order status.</p></div></div>
                                            {assignmentResponseMessage && <div className="success-message" role="status">{assignmentResponseMessage}</div>}
                                            {assignmentResponseError && <div className="error-message" role="alert">{assignmentResponseError}</div>}
                                            <div className="writer-assignment-toolbar" aria-label="Assignment search and sorting">
                                                <label className="writer-assignment-toolbar__search" htmlFor="assignment-search"><span>Search assignments</span><input id="assignment-search" type="search" value={assignmentSearch} onChange={(event) => { setAssignmentSearch(event.target.value); setCompletedPage(1); }} placeholder="Order ID, college, year, or branch" /></label>
                                                <label htmlFor="assignment-sort"><span>Sort by assignment date</span><select id="assignment-sort" value={assignmentSort} onChange={(event) => { setAssignmentSort(event.target.value as 'newest' | 'oldest'); setCompletedPage(1); }}>
                                                    <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
                                                </select></label>
                                            </div>
                                            <section className="writer-assignment-section" aria-labelledby="writer-pending-heading"><div className="writer-section-heading"><div><h3 id="writer-pending-heading">Awaiting your response</h3><p>Review the deadline and choose whether to accept.</p></div><span className="writer-section-count">{workspace.pendingAcceptanceCount}</span></div>
                                                {pendingAssignments.length === 0 ? <p className="writer-empty-state">{assignmentSearch ? 'No pending assignments match your search.' : 'No assignments are awaiting your response.'}</p> : <div className="writer-assignment-grid">{assignmentCards(pendingAssignments, 'pending')}</div>}
                                            </section>
                                            <section className="writer-assignment-section" aria-labelledby="writer-active-heading"><div className="writer-section-heading"><div><h3 id="writer-active-heading">Active work</h3><p>Accepted assignments awaiting completion or review.</p></div><span className="writer-section-count">{workspace.activeOrderCount}</span></div>
                                                {activeOrders.length === 0 ? <p className="writer-empty-state">{assignmentSearch ? 'No accepted assignments match your search.' : 'No accepted assignments.'}</p> : <div className="writer-assignment-grid">{assignmentCards(activeOrders, 'active')}</div>}
                                            </section>
                                            <section className="writer-assignment-section writer-assignment-section--history" aria-labelledby="writer-history-heading"><div className="writer-section-heading"><div><h3 id="writer-history-heading">Completed history</h3><p>Previously completed assignments.</p></div><span className="writer-section-count">{workspace.completedTotalCount}</span></div>
                                                {workspace.completedOrders.length === 0 ? <p className="writer-empty-state">{assignmentSearch ? 'No completed orders match your search.' : 'No completed orders yet.'}</p> : <div className="writer-assignment-grid">{assignmentCards(workspace.completedOrders, 'completed')}</div>}
                                                {workspace.completedTotalCount > 0 && (
                                                    <div className="pagination-row" aria-label="Completed history pagination">
                                                        <button type="button" className="btn btn-secondary" disabled={workspace.completedPage <= 1} onClick={() => setCompletedPage((page) => Math.max(page - 1, 1))}>Previous</button>
                                                        <span>Page {workspace.completedPage} of {workspace.completedTotalPages}</span>
                                                        <button type="button" className="btn btn-primary" disabled={workspace.completedPage >= workspace.completedTotalPages} onClick={() => setCompletedPage((page) => Math.min(page + 1, workspace.completedTotalPages))}>Next</button>
                                                    </div>
                                                )}
                                            </section>
                                        </>
                                    )}
                                </>
                            )}
                            {application.applicationStatus === 'rejected' && (
                                <section className="writer-notice writer-notice--rejected">
                                    <p>Your writer application was not approved.</p>
                                    {application.rejectionReason && <p><strong>Admin note:</strong> {application.rejectionReason}</p>}
                                </section>
                            )}
                        </>
                    )}
                </div>
            </main>
        </>
    );
}
