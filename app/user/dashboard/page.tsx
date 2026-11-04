'use client';

import BrandMark from '@/components/BrandMark';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Order } from '@/lib/types';

type OrderWithDeliveryToken = Order & {
    deliveryDownloadToken?: string;
    feedbackEligible?: boolean;
    feedbackSubmitted?: boolean;
    feedbackRating?: number;
};

type PendingRatingOrder = {
    orderId: string;
    deliveryFile: string;
    deliveryDownloadToken: string;
};

type CustomerOrderSummary = { total: number; submitted: number; inProgress: number; completed: number };

const calendarMonths = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

export default function UserDashboardPage() {
    const router = useRouter();
    const [user, setUser] = useState<{ name: string; email: string } | null>(null);
    const [orders, setOrders] = useState<OrderWithDeliveryToken[]>([]);
    const [pendingRatings, setPendingRatings] = useState<PendingRatingOrder[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [summary, setSummary] = useState<CustomerOrderSummary>({ total: 0, submitted: 0, inProgress: 0, completed: 0 });
    const [orderSearch, setOrderSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('All');
    const [monthFilter, setMonthFilter] = useState('All');
    const [monthMenuOpen, setMonthMenuOpen] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const ordersPerPage = 5;
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [reviewRatings, setReviewRatings] = useState<Record<string, number>>({});
    const [reviewDisplayNames, setReviewDisplayNames] = useState<Record<string, string>>({});
    const [reviewTexts, setReviewTexts] = useState<Record<string, string>>({});
    const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
    const [ratingSubmitting, setRatingSubmitting] = useState(false);
    const [ratingSubmitError, setRatingSubmitError] = useState('');
    const ratingDialogRef = useRef<HTMLDivElement>(null);
    const restoreFocusRef = useRef<HTMLElement | null>(null);
    const monthFilterRef = useRef<HTMLDivElement>(null);
    const monthTriggerRef = useRef<HTMLButtonElement>(null);
    const monthOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const ordersRequestId = useRef(0);

    useEffect(() => {
        const stored = localStorage.getItem('userAuth');
        if (!stored) return;

        try {
            const parsed = JSON.parse(stored);
            if (!parsed?.email) {
                localStorage.removeItem('userAuth');
                return;
            }
            setUser(parsed);
        } catch {
            localStorage.removeItem('userAuth');
        }
    }, [router]);

    const fetchOrders = async () => {
        const requestId = ++ordersRequestId.current;
        try {
            const params = new URLSearchParams({
                page: String(currentPage),
                limit: String(ordersPerPage),
                search: orderSearch.trim(),
                status: statusFilter,
                month: monthFilter,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            });
            const res = await fetch(`/api/user/orders?${params.toString()}`, { cache: 'no-store' });
            if (!res.ok) throw new Error('Failed to fetch orders');
            const data = await res.json() as {
                orders: OrderWithDeliveryToken[];
                pendingRatings: PendingRatingOrder[];
                totalCount: number;
                summary: CustomerOrderSummary;
            };
            if (requestId !== ordersRequestId.current) return;
            setOrders(data.orders);
            setPendingRatings(data.pendingRatings);
            setTotalCount(data.totalCount);
            setSummary(data.summary);
            setCurrentPage((page) => Math.min(page, Math.max(1, Math.ceil(data.totalCount / ordersPerPage))));
        } catch (err: any) {
            if (requestId === ordersRequestId.current) setError(err.message || 'Could not load orders');
        } finally {
            if (requestId === ordersRequestId.current) setLoading(false);
        }
    };

    useEffect(() => {
        if (!user?.email) return;
        const timeout = window.setTimeout(() => { void fetchOrders(); }, orderSearch ? 250 : 0);
        return () => window.clearTimeout(timeout);
    }, [user?.email, currentPage, orderSearch, statusFilter, monthFilter]);

    const submitPendingReviews = async () => {
        if (ratingSubmitting || pendingRatingOrders.length === 0) return;
        const missingDetails = pendingRatingOrders.find((order) => {
            const name = (reviewDisplayNames[order.orderId] ?? user?.name ?? '').trim();
            const text = (reviewTexts[order.orderId] ?? '').trim();
            return !Number.isInteger(reviewRatings[order.orderId]) || reviewRatings[order.orderId] < 1 || reviewRatings[order.orderId] > 5 || name.length < 2 || name.length > 60 || text.length < 10 || text.length > 1000;
        });
        if (missingDetails) {
            setRatingSubmitError(`Add a display name, a review of 10–1000 characters, and a rating for order ${missingDetails.orderId}.`);
            return;
        }

        setRatingSubmitting(true);
        setRatingSubmitError('');
        for (const order of pendingRatingOrders) {
            const rating = reviewRatings[order.orderId];
            const displayName = (reviewDisplayNames[order.orderId] ?? user?.name ?? '').trim();
            const text = (reviewTexts[order.orderId] ?? '').trim();
            setReviewErrors((current) => ({ ...current, [order.orderId]: '' }));
            try {
                const response = await fetch(`/api/user/orders/${encodeURIComponent(order.orderId)}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rating, displayName, text }),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Could not submit feedback');
                if (result.feedbackSubmitted !== true || result.rating !== rating) {
                    throw new Error('The server did not confirm that your review was saved. Please try again.');
                }
                setOrders((current) => current.map((item) => item.orderId === order.orderId
                    ? { ...item, feedbackSubmitted: true, feedbackRating: result.rating }
                    : item));
                setPendingRatings((current) => current.filter((item) => item.orderId !== order.orderId));
            } catch (reason: unknown) {
                const message = reason instanceof Error ? reason.message : 'Could not submit feedback';
                setReviewErrors((current) => ({ ...current, [order.orderId]: message }));
                setRatingSubmitError(`Could not save the rating for order ${order.orderId}. ${message}`);
                setRatingSubmitting(false);
                return;
            }
        }
        setRatingSubmitting(false);
    };

    const handleLogout = async () => {
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST' });
            if (!response.ok) return;
            localStorage.removeItem('userAuth');
            router.replace('/user/login');
            router.refresh();
        } catch {
            setError('Logout failed. Please try again.');
        }
    };

    const getStatusBadgeClass = (status: string) => {
        switch (status) {
            case 'Submitted': return 'status-badge status-submitted';
            case 'In Progress': return 'status-badge status-in-progress';
            case 'Completed': return 'status-badge status-completed';
            default: return 'status-badge';
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'Submitted': return '📋';
            case 'In Progress': return '⚙️';
            case 'Completed': return '✅';
            default: return '📄';
        }
    };

    const pendingRatingOrders = pendingRatings;
    const ratingRequired = pendingRatingOrders.length > 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / ordersPerPage));
    const currentOrders = orders;
    const customerActionsBlocked = loading || Boolean(error);
    const customerActionLockText = loading ? 'Checking required order ratings…' : 'Order actions are unavailable until your orders load';

    useEffect(() => {
        if (!monthMenuOpen) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (event.target instanceof Node && !monthFilterRef.current?.contains(event.target)) {
                setMonthMenuOpen(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setMonthMenuOpen(false);
                monthTriggerRef.current?.focus();
            }
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePointer);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [monthMenuOpen]);

    useEffect(() => {
        if (!ratingRequired) {
            restoreFocusRef.current?.focus();
            restoreFocusRef.current = null;
            return;
        }

        restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        ratingDialogRef.current?.focus();
        const handleDialogKeys = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                return;
            }
            if (event.key !== 'Tab' || !ratingDialogRef.current) return;
            const focusable = [...ratingDialogRef.current.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )].filter((element) => element.offsetParent !== null);
            if (focusable.length === 0) {
                event.preventDefault();
                ratingDialogRef.current.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === ratingDialogRef.current)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleDialogKeys);
        return () => document.removeEventListener('keydown', handleDialogKeys);
    }, [ratingRequired]);

    return (
        <>
            <div inert={ratingRequired || undefined} aria-hidden={ratingRequired || undefined}>
            <header className="header">
                <div className="header-content">
                    <BrandMark />
                    <nav>
                        {customerActionsBlocked ? (
                            <span aria-disabled="true" title={customerActionLockText} style={{ color: '#6B7280' }}>Track Order</span>
                        ) : <Link href="/track">Track Order</Link>}
                        {customerActionsBlocked ? (
                            <span aria-disabled="true" title={customerActionLockText} style={{ color: '#6B7280' }}>Submit New Order</span>
                        ) : <Link href="/submit">Submit New Order</Link>}
                        {user && (
                            <span style={{ color: '#6B7280', fontSize: '0.9rem' }}>
                                👤 {user.name}
                            </span>
                        )}
                        <button
                            onClick={handleLogout}
                            className="btn btn-secondary"
                            style={{ padding: '0.4rem 1rem', fontSize: '0.9rem' }}
                        >
                            Logout
                        </button>
                    </nav>
                </div>
            </header>

            <div className="container customer-dashboard-page" style={{ maxWidth: '1000px' }}>
                {/* Welcome Banner */}
                <div style={{
                    background: 'linear-gradient(135deg, #DC2626 0%, #B91C1C 100%)',
                    borderRadius: '12px',
                    padding: '2rem',
                    marginBottom: '2rem',
                    color: 'white',
                }}>
                    <h2 style={{ color: 'white', marginBottom: '0.25rem', fontSize: '1.5rem' }}>
                        Welcome back, {user?.name?.split(' ')[0]}! 👋
                    </h2>
                    <p style={{ opacity: 0.85, margin: 0, fontSize: '0.95rem' }}>
                        {user?.email} · {summary.total} order{summary.total !== 1 ? 's' : ''} total
                    </p>
                </div>

                {/* Stats Row */}
                <div className="dashboard-stats-grid">
                    {[
                        { label: 'Total Orders', value: summary.total, color: '#1F2937' },
                        { label: 'In Progress', value: summary.inProgress, color: '#92400E' },
                        { label: 'Completed', value: summary.completed, color: '#065F46' },
                    ].map((stat) => (
                        <div key={stat.label} className="card" style={{ textAlign: 'center', padding: '1.25rem' }}>
                            <div style={{ fontSize: '2rem', fontWeight: 700, color: stat.color }}>
                                {stat.value}
                            </div>
                            <div style={{ color: '#6B7280', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                                {stat.label}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Order History */}
                <div className="card">
                    <div className="card-title-row">
                        <h3 style={{ margin: 0, fontSize: '1.25rem' }}>Order History</h3>
                        {customerActionsBlocked ? (
                            <button type="button" className="btn btn-primary" disabled title={customerActionLockText} style={{ padding: '0.5rem 1.25rem', fontSize: '0.9rem' }}>
                                + New Order · {loading ? 'loading' : 'unavailable'}
                            </button>
                        ) : (
                            <Link href="/submit" className="btn btn-primary" style={{ padding: '0.5rem 1.25rem', fontSize: '0.9rem' }}>
                                + New Order
                            </Link>
                        )}
                    </div>

                    {error && <div className="error-message">{error}</div>}

                    <div className="dashboard-toolbar" style={{ margin: '1rem 0' }}>
                        <input
                            type="search"
                            aria-label="Search by order ID"
                            placeholder="Search order ID..."
                            value={orderSearch}
                            onChange={(event) => {
                                setOrderSearch(event.target.value);
                                setCurrentPage(1);
                            }}
                            style={{ flex: '1 1 220px', minWidth: 0, padding: '0.5rem 1rem', border: '1px solid #D1D5DB', borderRadius: '6px' }}
                        />
                        <select
                            aria-label="Filter orders by status"
                            value={statusFilter}
                            onChange={(event) => {
                                setStatusFilter(event.target.value);
                                setCurrentPage(1);
                            }}
                            style={{ flex: '1 1 180px', minWidth: 0, padding: '0.5rem 1rem', border: '1px solid #D1D5DB', borderRadius: '6px', background: 'white' }}
                        >
                            <option value="All">All statuses</option>
                            <option value="Submitted">Submitted</option>
                            <option value="In Progress">In Progress</option>
                            <option value="Completed">Completed</option>
                        </select>
                        <div
                            className={`customer-month-filter${monthMenuOpen ? ' is-open' : ''}`}
                            ref={monthFilterRef}
                        >
                            <button
                                ref={monthTriggerRef}
                                type="button"
                                className="customer-month-trigger"
                                aria-haspopup="menu"
                                aria-expanded={monthMenuOpen}
                                aria-controls="customer-month-menu"
                                onClick={() => setMonthMenuOpen((open) => !open)}
                                onKeyDown={(event) => {
                                    if (event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        setMonthMenuOpen(true);
                                        requestAnimationFrame(() => monthOptionRefs.current[0]?.focus());
                                    }
                                }}
                            >
                                Month: {monthFilter === 'All' ? 'All months' : calendarMonths[Number(monthFilter)]}
                                <span aria-hidden="true"> ▸</span>
                            </button>
                            {monthMenuOpen && (
                                <div
                                    id="customer-month-menu"
                                    className="customer-month-menu"
                                    role="menu"
                                    aria-label="Filter by month"
                                    onKeyDown={(event) => {
                                        const currentIndex = monthOptionRefs.current.findIndex((option) => option === document.activeElement);
                                        let nextIndex: number | null = null;
                                        if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % 13;
                                        if (event.key === 'ArrowUp') nextIndex = (currentIndex + 12) % 13;
                                        if (event.key === 'Home') nextIndex = 0;
                                        if (event.key === 'End') nextIndex = 12;
                                        if (nextIndex !== null) {
                                            event.preventDefault();
                                            monthOptionRefs.current[nextIndex]?.focus();
                                        }
                                    }}
                                >
                                    {[
                                        { label: 'All months', value: 'All' },
                                        ...calendarMonths.map((label, index) => ({ label, value: String(index) })),
                                    ].map((month, index) => (
                                        <button
                                            key={month.value}
                                            ref={(element) => { monthOptionRefs.current[index] = element; }}
                                            type="button"
                                            role="menuitemradio"
                                            aria-checked={monthFilter === month.value}
                                            className="customer-month-option"
                                            onClick={() => {
                                                setMonthFilter(month.value);
                                                setCurrentPage(1);
                                                setMonthMenuOpen(false);
                                                monthTriggerRef.current?.focus();
                                            }}
                                        >
                                            {month.label}{monthFilter === month.value ? ' ✓' : ''}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {loading ? (
                        <div className="spinner"></div>
                    ) : summary.total === 0 ? (
                        <div style={{ textAlign: 'center', padding: '3rem 1rem', color: '#6B7280' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📭</div>
                            <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem', fontWeight: 500 }}>No orders yet</p>
                            <p style={{ fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                                Make sure you use this email address ({user?.email}) when submitting orders.
                            </p>
                            {customerActionsBlocked ? (
                                <button type="button" className="btn btn-primary" disabled title={customerActionLockText}>Submit Your First Order</button>
                            ) : <Link href="/submit" className="btn btn-primary">Submit Your First Order</Link>}
                        </div>
                    ) : totalCount === 0 ? (
                        <p style={{ textAlign: 'center', color: '#6B7280', padding: '2rem' }}>No orders match your search, status, and month filters.</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            {currentOrders.map((order) => (
                                <div
                                    key={order.orderId}
                                    className="customer-order-card"
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
                                        <div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                                                <span style={{ fontSize: '1.1rem' }}>{getStatusIcon(order.orderStatus)}</span>
                                                <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1rem', color: '#1F2937' }}>
                                                    {order.orderId}
                                                </span>
                                            </div>
                                            <div style={{ color: '#6B7280', fontSize: '0.875rem' }}>
                                                {new Date(order.createdDate).toLocaleDateString('en-IN', {
                                                    day: 'numeric', month: 'long', year: 'numeric',
                                                })}
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem' }}>
                                            <span className={getStatusBadgeClass(order.orderStatus)}>
                                                {order.orderStatus}
                                            </span>
                                            {order.orderStatus === 'Completed' && (
                                                <span
                                                    role="status"
                                                    className="status-badge"
                                                    style={{
                                                        fontSize: '0.75rem',
                                                        color: order.physicalDeliveryStatus === 'Delivered' ? '#065F46' : '#92400E',
                                                        backgroundColor: order.physicalDeliveryStatus === 'Delivered' ? '#D1FAE5' : '#FEF3C7',
                                                        border: `1px solid ${order.physicalDeliveryStatus === 'Delivered' ? '#6EE7B7' : '#FCD34D'}`,
                                                        textAlign: 'right',
                                                    }}
                                                >
                                                    Physical delivery: {order.physicalDeliveryStatus || 'Pending'}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    <div style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                                        gap: '0.5rem',
                                        marginTop: '1rem',
                                        paddingTop: '1rem',
                                        borderTop: '1px solid #F3F4F6',
                                        fontSize: '0.875rem',
                                        color: '#4B5563',
                                    }}>
                                        <div><span style={{ fontWeight: 600 }}>College:</span> {order.collegeName}</div>
                                        <div><span style={{ fontWeight: 600 }}>Branch:</span> {order.branch}</div>
                                        <div><span style={{ fontWeight: 600 }}>Year:</span> {order.yearOfStudying}</div>
                                        {order.priceAmount && (
                                            <div><span style={{ fontWeight: 600 }}>Amount:</span> ₹{order.priceAmount}</div>
                                        )}
                                    </div>

                                    {order.instructions && (
                                        <div style={{
                                            marginTop: '0.75rem',
                                            fontSize: '0.875rem',
                                            color: '#6B7280',
                                            background: '#F9FAFB',
                                            borderRadius: '6px',
                                            padding: '0.6rem 0.75rem',
                                            whiteSpace: 'pre-wrap',
                                            overflow: 'hidden',
                                            display: '-webkit-box',
                                            WebkitLineClamp: 2,
                                            WebkitBoxOrient: 'vertical',
                                        }}>
                                            {order.instructions}
                                        </div>
                                    )}

                                    {order.orderStatus === 'Completed' && order.deliveryFile && (
                                        <div style={{ marginTop: '0.75rem' }}>
                                            <a
                                                href={`/api/files/${encodeURIComponent(order.deliveryFile)}?token=${encodeURIComponent(order.deliveryDownloadToken || '')}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="btn btn-success"
                                                style={{ padding: '0.4rem 1rem', fontSize: '0.875rem', display: 'inline-block' }}
                                            >
                                                ⬇ Download Completed Work
                                            </a>
                                        </div>
                                    )}

                                    <div style={{ marginTop: '0.75rem' }}>
                                        {customerActionsBlocked ? (
                                            <button type="button" className="btn btn-secondary" disabled title={customerActionLockText} style={{ padding: '0.4rem 1rem', fontSize: '0.875rem' }}>
                                                View Details · {loading ? 'loading' : 'unavailable'}
                                            </button>
                                        ) : (
                                            <Link href={`/user/orders/${encodeURIComponent(order.orderId)}`} className="btn btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.875rem' }}>
                                                View Details
                                            </Link>
                                        )}
                                    </div>

                                    {order.orderStatus === 'Completed' && order.deliveryFile && (
                                        <section className="customer-order-review-panel" aria-labelledby={`feedback-title-${order.orderId}`}>
                                            <h4 id={`feedback-title-${order.orderId}`} style={{ marginBottom: '0.5rem' }}>Rate your completed order</h4>
                                            {order.feedbackSubmitted ? (
                                                <p className="success-message" role="status">Thank you. You submitted a {order.feedbackRating} star review.</p>
                                            ) : order.feedbackEligible ? (
                                                <p>Rating required. Use the rating dialog to submit your review.</p>
                                            ) : (
                                                <p style={{ color: '#6B7280' }}>Feedback is unavailable because this completed order has no recorded writer attribution.</p>
                                            )}
                                        </section>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                    {!loading && totalCount > 0 && (
                        <div className="pagination-row" aria-label="Order history pagination">
                            <button
                                type="button"
                                onClick={() => setCurrentPage((page) => Math.max(page - 1, 1))}
                                disabled={currentPage <= 1}
                                className="btn btn-secondary"
                            >Previous</button>
                            <span aria-live="polite">Page {Math.min(currentPage, totalPages)} of {totalPages}</span>
                            <button
                                type="button"
                                onClick={() => setCurrentPage((page) => Math.min(page + 1, totalPages))}
                                disabled={currentPage >= totalPages}
                                className="btn btn-primary"
                            >Next</button>
                        </div>
                    )}
                </div>
            </div>
            </div>
            {ratingRequired && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(17, 24, 39, 0.68)' }}>
                    <div ref={ratingDialogRef} role="dialog" aria-modal="true" aria-labelledby="required-rating-title" aria-describedby="required-rating-description" tabIndex={-1} className="card" style={{ width: 'min(100%, 680px)', maxHeight: '90vh', overflowY: 'auto', padding: 'clamp(1rem, 4vw, 2rem)', outline: 'none' }}>
                        <h2 id="required-rating-title" style={{ marginTop: 0 }}>Rate your completed orders</h2>
                        <p id="required-rating-description">Please rate each delivered order to continue using your dashboard. You can still download your completed work or log out here.</p>
                        {pendingRatingOrders.map((order) => (
                            <section key={order.orderId} aria-labelledby={`dialog-rating-title-${order.orderId}`} style={{ borderTop: '1px solid #E5E7EB', paddingTop: '1rem', marginTop: '1rem' }}>
                                <h3 id={`dialog-rating-title-${order.orderId}`} style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>Order {order.orderId}</h3>
                                {order.deliveryFile && <p><a href={`/api/files/${encodeURIComponent(order.deliveryFile)}?token=${encodeURIComponent(order.deliveryDownloadToken || '')}`} target="_blank" rel="noopener noreferrer">Download completed work</a></p>}
                                <fieldset disabled={ratingSubmitting} style={{ border: 0, padding: 0, margin: '0.5rem 0' }}>
                                    <legend>Choose a rating from 1 to 5</legend>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                                        {[1, 2, 3, 4, 5].map((rating) => (
                                            <label key={rating} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                                                <input type="radio" name={`required-rating-${order.orderId}`} value={rating} checked={reviewRatings[order.orderId] === rating} onChange={() => setReviewRatings((current) => ({ ...current, [order.orderId]: rating }))} />
                                                {rating} {rating === 1 ? 'star' : 'stars'}
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>
                                <label style={{ display: 'grid', gap: '0.35rem', marginTop: '0.75rem' }}>
                                    Display name <span style={{ color: '#6B7280' }}>Shown publicly with your review</span>
                                    <input type="text" maxLength={60} required value={reviewDisplayNames[order.orderId] ?? user?.name ?? ''} disabled={ratingSubmitting} onChange={(event) => setReviewDisplayNames((current) => ({ ...current, [order.orderId]: event.target.value }))} autoComplete="nickname" />
                                </label>
                                <label style={{ display: 'grid', gap: '0.35rem', marginTop: '0.75rem' }}>
                                    Your review
                                    <textarea maxLength={1000} minLength={10} required rows={3} value={reviewTexts[order.orderId] ?? ''} disabled={ratingSubmitting} onChange={(event) => setReviewTexts((current) => ({ ...current, [order.orderId]: event.target.value }))} placeholder="Share a few words about your experience." />
                                </label>
                                {reviewErrors[order.orderId] && <p role="alert" className="error-message">{reviewErrors[order.orderId]}</p>}
                            </section>
                        ))}
                        {ratingSubmitError && <p role="alert" className="error-message">{ratingSubmitError}</p>}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '1.25rem' }}>
                            <button type="button" className="btn btn-primary" disabled={ratingSubmitting || pendingRatingOrders.some((order) => !Number.isInteger(reviewRatings[order.orderId]) || reviewRatings[order.orderId] < 1 || reviewRatings[order.orderId] > 5 || (reviewDisplayNames[order.orderId] ?? user?.name ?? '').trim().length < 2 || (reviewTexts[order.orderId] ?? '').trim().length < 10)} onClick={() => void submitPendingReviews()}>{ratingSubmitting ? 'Saving reviews…' : 'Submit all reviews'}</button>
                            <button type="button" className="btn btn-secondary" onClick={() => void handleLogout()}>Logout</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
