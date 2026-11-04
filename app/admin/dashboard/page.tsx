'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Order } from '@/lib/types';
import AdminNav from '@/app/admin/AdminNav';

type SubmissionQueueItem = {
    orderId: string;
    orderStatus: string;
    customer: { name?: string; collegeName?: string; yearOfStudying?: string; branch?: string };
    submissionId: string;
    assignmentVersion: number;
    submittedAt: string;
    fileUrl: string;
    writer: { id: string; name: string; email: string };
};

type OrderDashboardSummary = { total: number; submitted: number; inProgress: number; completed: number };

export default function AdminDashboard() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [summary, setSummary] = useState<OrderDashboardSummary>({ total: 0, submitted: 0, inProgress: 0, completed: 0 });
    const [unassignedOrders, setUnassignedOrders] = useState<Array<Pick<Order, 'orderId' | 'orderStatus' | 'collegeName'>>>([]);
    const [filter, setFilter] = useState('All');
    const [search, setSearch] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const ordersPerPage = 10;
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [submissionQueue, setSubmissionQueue] = useState<SubmissionQueueItem[]>([]);
    const [submissionQueueLoading, setSubmissionQueueLoading] = useState(true);
    const [submissionQueueError, setSubmissionQueueError] = useState('');
    const ordersRequestId = useRef(0);
    const submissionQueueRequestId = useRef(0);
    const dashboardQueryRef = useRef({ currentPage, filter, search });
    dashboardQueryRef.current = { currentPage, filter, search };

    useEffect(() => {
        fetchSubmissionQueue();
    }, []);

    useEffect(() => {
        const timeout = window.setTimeout(fetchOrders, search ? 250 : 0);
        return () => window.clearTimeout(timeout);
    }, [currentPage, filter, search]);

    useEffect(() => {
        const refreshVisibleDashboard = () => {
            if (document.visibilityState !== 'visible') return;
            fetchOrders();
            fetchSubmissionQueue();
        };
        const timer = window.setInterval(refreshVisibleDashboard, 30_000);
        window.addEventListener('focus', refreshVisibleDashboard);
        document.addEventListener('visibilitychange', refreshVisibleDashboard);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', refreshVisibleDashboard);
            document.removeEventListener('visibilitychange', refreshVisibleDashboard);
        };
    }, []);

    const fetchOrders = async () => {
        const requestId = ++ordersRequestId.current;
        try {
            const query = dashboardQueryRef.current;
            const params = new URLSearchParams({
                page: String(query.currentPage),
                limit: String(ordersPerPage),
                search: query.search.trim(),
                status: query.filter === 'Completed' || query.filter === 'In Progress' ? query.filter : 'All',
            });
            if (query.filter === 'Today' || query.filter === 'This Month') {
                const start = new Date();
                const end = new Date();
                if (query.filter === 'Today') {
                    start.setHours(0, 0, 0, 0);
                    end.setHours(0, 0, 0, 0);
                    end.setDate(end.getDate() + 1);
                } else {
                    start.setDate(1);
                    start.setHours(0, 0, 0, 0);
                    end.setFullYear(start.getFullYear(), start.getMonth() + 1, 1);
                    end.setHours(0, 0, 0, 0);
                }
                params.set('dateFrom', start.toISOString());
                params.set('dateTo', end.toISOString());
            }
            const response = await fetch(`/api/orders?${params.toString()}`, { cache: 'no-store' });

            if (!response.ok) {
                throw new Error('Failed to fetch orders');
            }

            const data = await response.json() as {
                orders: Order[];
                totalCount: number;
                summary: OrderDashboardSummary;
                unassignedOrders: Array<Pick<Order, 'orderId' | 'orderStatus' | 'collegeName'>>;
            };
            if (requestId === ordersRequestId.current) {
                setOrders(data.orders);
                setTotalCount(data.totalCount);
                setSummary(data.summary);
                setUnassignedOrders(data.unassignedOrders);
                setCurrentPage((page) => Math.min(page, Math.max(1, Math.ceil(data.totalCount / ordersPerPage))));
                setError('');
            }

        } catch (err: any) {
            if (requestId === ordersRequestId.current) setError(err.message || 'An error occurred');
        } finally {
            if (requestId === ordersRequestId.current) setLoading(false);
        }
    };

    const fetchSubmissionQueue = async () => {
        const requestId = ++submissionQueueRequestId.current;
        try {
            const response = await fetch('/api/admin/submissions', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not load review queue');
            if (requestId === submissionQueueRequestId.current) {
                setSubmissionQueue(data);
                setSubmissionQueueError('');
            }
        } catch (reason: unknown) {
            if (requestId === submissionQueueRequestId.current) {
                setSubmissionQueueError(reason instanceof Error ? reason.message : 'Could not load review queue');
            }
        } finally {
            if (requestId === submissionQueueRequestId.current) setSubmissionQueueLoading(false);
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
    const currentOrders = orders;
    const totalPages = Math.max(1, Math.ceil(totalCount / ordersPerPage));
    return (
        <>
            <AdminNav />

            <main className="container admin-page admin-dashboard-page">
                <div className="card admin-panel" id="orders-dashboard">
                    <div className="card-title-row">
                        <div><p className="admin-eyebrow">OPERATIONS</p><h1>Orders Dashboard</h1><p className="admin-section-description">Monitor orders, review submissions and assign active work.</p></div>
                        <div className="admin-dashboard-total">
                            Total Orders: <strong>{summary.total}</strong>
                        </div>
                    </div>

                    {error && <div className="error-message">{error}</div>}
                    <div className="dashboard-stats-grid">
            <div className="card admin-stat-card">
                <h3>Total Orders</h3>
                <p style={{ fontSize: '2rem', fontWeight: 'bold' }}>
                {summary.total}
                </p>
            </div>

            <div className="card admin-stat-card">
                <h3>Pending</h3>
                <p style={{ fontSize: '2rem', fontWeight: 'bold', color: '#D97706' }}>
                {summary.submitted}
                </p>
            </div>

            <div className="card admin-stat-card">
                <h3>In Progress</h3>
                <p style={{ fontSize: '2rem', fontWeight: 'bold', color: '#2563EB' }}>
                {summary.inProgress}
                </p>
            </div>

            <div className="card admin-stat-card">
                <h3>Completed</h3>
                <p style={{ fontSize: '2rem', fontWeight: 'bold', color: '#059669' }}>
                {summary.completed}
                </p>
            </div>
            </div>
            <div className="dashboard-toolbar admin-toolbar" aria-label="Order search and filters">
            <label className="admin-search-field"><span>Search orders</span>
            <input
            type="text"
            placeholder="Order ID, customer, or college"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setCurrentPage(1); }}
/>
            </label>
            <label className="admin-filter-field"><span>Filter orders</span>
    <select
        value={filter}
        onChange={(e) => { setFilter(e.target.value); setCurrentPage(1); }}
    >
        <option value="All">All Orders</option>
        <option value="Today">Today</option>
        <option value="This Month">This Month</option>
        <option value="Completed">Completed</option>
        <option value="In Progress">In Progress</option>
    </select>
    </label>
</div>
                    {totalCount === 0 ? (
                        <p style={{ textAlign: 'center', color: '#6b7280', padding: '2rem' }}>
                            {summary.total === 0 ? 'No orders found' : 'No orders match the current search and filter.'}
                        </p>
                    ) : (
                        <div>
                        <div className="table-container">
                            <table className="admin-orders-table admin-data-table">
                                <thead>
                                    <tr>
                                        <th>Order ID</th>
                                        <th>User Name</th>
                                        <th>College Name</th>
                                        <th>Order Status</th>
                                        <th>Physical Delivery</th>
                                        <th>Created Date</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>

                                <tbody>
                                    {currentOrders.map((order) => (
                                        <tr key={order.orderId}>
                                            <td style={{ fontFamily: 'monospace' }}>
                                                {order.orderId}
                                            </td>

                                            <td>{order.userName}</td>

                                            <td>{order.collegeName}</td>

                                            <td>
                                                <span className={getStatusBadgeClass(order.orderStatus)}>
                                                    {order.orderStatus}
                                                </span>
                                            </td>

                                            <td>{order.orderStatus === 'Completed' ? (order.physicalDeliveryStatus || 'Pending') : '—'}</td>

                                            <td>
                                                {new Date(order.createdDate).toLocaleDateString('en-IN', {
                                                    day: '2-digit',
                                                    month: 'short',
                                                    year: 'numeric',
                                                })}
                                            </td>

                                            <td>
                                                <Link href={`/admin/order/${order.orderId}`}>
                                                    View Details
                                                </Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="pagination-row">
                            <button
                                onClick={() =>
                                    setCurrentPage((prev) => Math.max(prev - 1, 1))
                                }
                                disabled={currentPage === 1}
                                className="btn btn-secondary"
                            >
                                Previous
                            </button>

                            <span style={{ paddingTop: '0.5rem' }}>
                                Page {currentPage} of {totalPages}
                            </span>

                            <button
                                onClick={() =>
                                    setCurrentPage((prev) =>
                                        Math.min(prev + 1, totalPages)
                                    )
                                }
                                disabled={currentPage >= totalPages}
                                className="btn btn-primary"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                    )}
                </div>
                <div className="card admin-panel" id="submissions">
                    <div className="card-title-row">
                        <div><p className="admin-eyebrow">QUALITY REVIEW</p><h2>Writer Submission Review</h2><p className="admin-section-description">Review completed work before it becomes available to customers.</p></div>
                        <span className="admin-count-badge">{submissionQueue.length} awaiting review</span>
                    </div>
                    {submissionQueueError && <div className="error-message" role="alert">{submissionQueueError}</div>}
                    {submissionQueueLoading ? <div className="spinner" /> : submissionQueue.length === 0 ? (
                        <p>No writer submissions are awaiting review.</p>
                    ) : (
                        <div className="table-container">
                            <table className="admin-submissions-table admin-data-table">
                                <thead><tr><th>Order</th><th>Customer / Order</th><th>Writer</th><th>Assignment</th><th>Submitted</th><th>File</th><th>Status</th><th>Review</th></tr></thead>
                                <tbody>
                                    {submissionQueue.map((item) => (
                                        <tr key={`${item.orderId}:${item.submissionId}`}>
                                            <td><Link href={`/admin/writer-review/${encodeURIComponent(item.orderId)}`}>{item.orderId}</Link></td>
                                            <td>
                                                {item.customer.name || 'Customer'}<br />
                                                <small>{item.customer.collegeName || 'College unavailable'} · {item.customer.yearOfStudying || 'Year unavailable'} · {item.customer.branch || 'Branch unavailable'}</small><br />
                                                <small>Order status: {item.orderStatus}</small>
                                            </td>
                                            <td>{item.writer.name}<br /><small>{item.writer.email}</small></td>
                                            <td>Version {item.assignmentVersion}</td>
                                            <td>{new Date(item.submittedAt).toLocaleString('en-IN')}</td>
                                            <td><a href={item.fileUrl} target="_blank" rel="noopener noreferrer">Open submitted file</a></td>
                                            <td><span className="status-badge status-submitted">Pending review</span></td>
                                            <td>
                                                <Link className="btn btn-primary" href={`/admin/writer-review/${encodeURIComponent(item.orderId)}`}>Review submission</Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
                <div className="card admin-panel">
                    <div className="card-title-row">
                        <div><p className="admin-eyebrow">STAFFING</p><h2>Unassigned Orders</h2><p className="admin-section-description">Active orders that need a writer assignment.</p></div>
                        <span className="admin-count-badge">{unassignedOrders.length} awaiting assignment</span>
                    </div>
                    {unassignedOrders.length === 0 ? <p>No active orders are awaiting assignment.</p> : (
                        <ul style={{ marginBottom: 0 }}>
                            {unassignedOrders.map((order) => (
                                <li key={order.orderId}>
                                    <Link href={`/admin/order/${order.orderId}`}>{order.orderId}</Link>
                                    {' — '}{order.orderStatus} · {order.collegeName}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </main>
        </>
    );
}
