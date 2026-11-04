'use client';

import Link from 'next/link';
import AdminNav from '@/app/admin/AdminNav';
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AdminAnalyticsData } from '@/lib/admin-analytics';
import type { OrderStatus } from '@/lib/types';

type MonthPoint = { month: string; revenue: number; orderCount: number; shortLabel: string; fullLabel: string };

const STATUS_COLORS: Record<OrderStatus, string> = {
    Submitted: '#D6A64A',
    'In Progress': '#E64B45',
    Completed: '#5F927A',
};

const fullCurrency = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
});

const compactCurrency = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    notation: 'compact',
    maximumFractionDigits: 1,
});

function monthKey(year: number, month: number): string {
    return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function createAnalyticsPeriod(now: Date) {
    const rangeStartDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const currentMonthStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const rangeEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    let timeZone = 'UTC';
    try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        // UTC keeps the chart period valid on runtimes without a resolved browser time zone.
    }

    const months = Array.from({ length: 12 }, (_, index) => {
        const date = new Date(now.getFullYear(), now.getMonth() - 11 + index, 1);
        const key = monthKey(date.getFullYear(), date.getMonth());
        return {
            month: key,
            shortLabel: new Intl.DateTimeFormat('en-IN', { month: 'short' }).format(date),
            fullLabel: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(date),
        };
    });

    const params = new URLSearchParams({
        rangeStart: rangeStartDate.toISOString(),
        currentMonthStart: currentMonthStartDate.toISOString(),
        rangeEnd: rangeEndDate.toISOString(),
        timeZone,
    });
    return { params, months };
}

function RevenueLineChart({ points }: { points: MonthPoint[] }) {
    const width = 840;
    const height = 320;
    const left = 86;
    const right = 18;
    const top = 18;
    const bottom = 270;
    const minRevenue = Math.min(0, ...points.map((point) => point.revenue));
    const maxRevenue = Math.max(0, ...points.map((point) => point.revenue));
    const revenueRange = maxRevenue - minRevenue || 1;
    const chartWidth = width - left - right;
    const chartHeight = bottom - top;
    const coordinates = points.map((point, index) => ({
        ...point,
        x: left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth),
        y: bottom - ((point.revenue - minRevenue) / revenueRange) * chartHeight,
    }));
    const line = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
    const ticks = Array.from({ length: 5 }, (_, index) => minRevenue + (revenueRange * index) / 4);

    return (
        <svg className="admin-analytics-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monthly revenue for the last 12 months">
            {ticks.map((value, index) => {
                const y = bottom - (index / 4) * chartHeight;
                return (
                    <g key={`${value}-${index}`}>
                        <line x1={left} x2={width - right} y1={y} y2={y} className="admin-analytics-gridline" />
                        <text x={left - 12} y={y + 4} textAnchor="end" className="admin-analytics-axis-label">{compactCurrency.format(value)}</text>
                    </g>
                );
            })}
            <path d={line} className="admin-analytics-revenue-line" />
            {coordinates.map((point) => (
                <g key={point.month}>
                    <circle cx={point.x} cy={point.y} r="4.5" className="admin-analytics-revenue-point">
                        <title>{`${point.fullLabel}: ${fullCurrency.format(point.revenue)} (${point.orderCount} orders)`}</title>
                    </circle>
                    <text x={point.x} y={bottom + 27} textAnchor="middle" className="admin-analytics-axis-label">{point.shortLabel}</text>
                </g>
            ))}
        </svg>
    );
}

function RevenueOverview({
    loading,
    error,
    points,
}: {
    loading: boolean;
    error: string;
    points: MonthPoint[];
}) {
    const hasOrders = points.some((point) => point.orderCount > 0);
    return (
        <section className="admin-analytics-chart-panel" aria-labelledby="revenue-overview-title">
            <div className="admin-analytics-chart-heading">
                <div><p className="admin-eyebrow">REVENUE</p><h2 id="revenue-overview-title">Revenue Overview</h2></div>
                <p>Monthly order revenue for the last 12 months.</p>
            </div>
            {loading ? <p role="status">Loading revenue chart…</p> : error ? <p role="alert" className="error-message">{error}</p> : !hasOrders ? (
                <p className="admin-analytics-empty">No orders were created in the last 12 months.</p>
            ) : (
                <div className="admin-analytics-chart-viewport"><RevenueLineChart points={points} /></div>
            )}
        </section>
    );
}

function OrderStatistics({
    loading,
    error,
    data,
}: {
    loading: boolean;
    error: string;
    data: AdminAnalyticsData | null;
}) {
    const [hoveredStatus, setHoveredStatus] = useState<OrderStatus | null>(null);
    const [selectedStatus, setSelectedStatus] = useState<OrderStatus | null>(null);
    const statistics = data?.orderStatistics || [];
    const total = statistics.reduce((sum, item) => sum + item.count, 0);
    const radius = 72;
    const circumference = 2 * Math.PI * radius;
    const activeStatus = hoveredStatus || selectedStatus;
    const activeItem = statistics.find((item) => item.status === activeStatus && item.count > 0);
    const activePercentage = activeItem && total > 0 ? (activeItem.count / total) * 100 : 0;
    const activeIndex = activeItem ? statistics.findIndex((item) => item.status === activeItem.status) : -1;
    const activeBefore = activeIndex >= 0 ? statistics.slice(0, activeIndex).reduce((sum, item) => sum + item.count, 0) : 0;
    const activeMiddleAngle = activeItem && total > 0
        ? ((activeBefore + activeItem.count / 2) / total) * (2 * Math.PI) - Math.PI / 2
        : 0;
    let consumedLength = 0;

    function toggleStatus(status: OrderStatus) {
        setSelectedStatus((current) => current === status ? null : status);
        setHoveredStatus(null);
    }

    function activateFromKeyboard(event: KeyboardEvent<SVGGElement>, status: OrderStatus) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleStatus(status);
        }
    }

    return (
        <section className="admin-analytics-chart-panel" aria-labelledby="order-statistics-title">
            <div className="admin-analytics-chart-heading">
                <div><p className="admin-eyebrow">ORDERS</p><h2 id="order-statistics-title">Order Statistics</h2></div>
                <p>Distribution across the existing order statuses.</p>
            </div>
            {loading ? <p role="status">Loading order statistics…</p> : error ? <p role="alert" className="error-message">{error}</p> : total === 0 ? (
                <p className="admin-analytics-empty">No orders are available to summarize.</p>
            ) : (
                <div className="admin-analytics-status-layout">
                    <div className="admin-analytics-doughnut-wrap">
                        <svg className="admin-analytics-doughnut" viewBox="0 0 220 220" role="group" aria-label={`Order status distribution, ${total} total orders`}>
                            <circle cx="110" cy="110" r={radius} fill="none" stroke="#E7D5BD" strokeWidth="24" aria-hidden="true" />
                            {statistics.map((item) => {
                            const segmentLength = total > 0 ? (item.count / total) * circumference : 0;
                            const currentOffset = consumedLength;
                            consumedLength += segmentLength;
                            if (item.count <= 0) return null;
                            const middleAngle = ((currentOffset + segmentLength / 2) / circumference) * (2 * Math.PI) - Math.PI / 2;
                            const isActive = activeStatus === item.status;
                            const isDimmed = activeStatus !== null && !isActive;
                            const offset = isActive ? 5 : 0;
                            const translateX = Math.cos(middleAngle) * offset;
                            const translateY = Math.sin(middleAngle) * offset;
                            return (
                                <g
                                    key={item.status}
                                    className={`admin-analytics-doughnut-segment${isActive ? ' is-active' : ''}${isDimmed ? ' is-dimmed' : ''}`}
                                    transform={`translate(${translateX} ${translateY}) rotate(-90 110 110)`}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`${item.status}: ${item.count} orders, ${((item.count / total) * 100).toFixed(1)} percent`}
                                    aria-pressed={selectedStatus === item.status}
                                    onMouseEnter={() => setHoveredStatus(item.status)}
                                    onMouseLeave={() => setHoveredStatus(null)}
                                    onFocus={() => setHoveredStatus(item.status)}
                                    onBlur={() => setHoveredStatus(null)}
                                    onClick={() => toggleStatus(item.status)}
                                    onKeyDown={(event) => activateFromKeyboard(event, item.status)}
                                >
                                    <circle
                                        cx="110"
                                        cy="110"
                                        r={radius}
                                        fill="none"
                                        stroke={STATUS_COLORS[item.status]}
                                        strokeWidth={isActive ? 30 : 24}
                                        strokeDasharray={`${segmentLength} ${circumference - segmentLength}`}
                                        strokeDashoffset={-currentOffset}
                                    />
                                </g>
                            );
                            })}
                            {activeItem ? (
                                <>
                                    <text x="110" y="101" textAnchor="middle" className="admin-analytics-doughnut-caption">{activeItem.status}</text>
                                    <text x="110" y="130" textAnchor="middle" className="admin-analytics-doughnut-total">{activeItem.count.toLocaleString('en-IN')}</text>
                                </>
                            ) : (
                                <>
                                    <text x="110" y="104" textAnchor="middle" className="admin-analytics-doughnut-total">{total}</text>
                                    <text x="110" y="128" textAnchor="middle" className="admin-analytics-doughnut-caption">Total orders</text>
                                </>
                            )}
                        </svg>
                        {activeItem && (
                            <div
                                className="admin-analytics-tooltip"
                                role="status"
                                aria-live="polite"
                                style={{
                                    left: `${Math.min(65, Math.max(35, 50 + Math.cos(activeMiddleAngle) * 20))}%`,
                                    top: `${Math.min(72, Math.max(28, 50 + Math.sin(activeMiddleAngle) * 25))}%`,
                                }}
                            >
                                <strong>{activeItem.status}</strong>
                                <span>{activeItem.count.toLocaleString('en-IN')} orders</span>
                                <span>{activePercentage.toFixed(1)}% of total</span>
                            </div>
                        )}
                    </div>
                    <ul className="admin-analytics-legend" aria-label="Order counts by status">
                        {statistics.map((item) => (
                            <li key={item.status}>
                                <button
                                    type="button"
                                    className={`admin-analytics-legend-item${activeStatus === item.status ? ' is-active' : ''}${activeStatus && activeStatus !== item.status ? ' is-dimmed' : ''}`}
                                    aria-pressed={selectedStatus === item.status}
                                    onMouseEnter={() => setHoveredStatus(item.status)}
                                    onMouseLeave={() => setHoveredStatus(null)}
                                    onFocus={() => setHoveredStatus(item.status)}
                                    onBlur={() => setHoveredStatus(null)}
                                    onClick={() => toggleStatus(item.status)}
                                >
                                    <span className="admin-analytics-legend-swatch" style={{ backgroundColor: STATUS_COLORS[item.status] }} aria-hidden="true" />
                                    <span>{item.status}</span>
                                    <strong>{item.count.toLocaleString('en-IN')}</strong>
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}

export default function AdminAnalyticsPage() {
    const [data, setData] = useState<AdminAnalyticsData | null>(null);
    const [monthLabels, setMonthLabels] = useState<Array<{ month: string; shortLabel: string; fullLabel: string }>>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        let active = true;
        const period = createAnalyticsPeriod(new Date());
        setMonthLabels(period.months);

        fetch(`/api/admin/analytics?${period.params.toString()}`, { cache: 'no-store' })
            .then(async (response) => {
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Could not load analytics');
                if (active) setData(result as AdminAnalyticsData);
            })
            .catch((reason: unknown) => {
                if (active) setError(reason instanceof Error ? reason.message : 'Could not load analytics');
            })
            .finally(() => { if (active) setLoading(false); });

        return () => { active = false; };
    }, []);

    const revenuePoints = useMemo(() => {
        const values = new Map((data?.monthlyRevenue || []).map((item) => [item.month, item]));
        return monthLabels.map((month) => ({
            ...month,
            revenue: values.get(month.month)?.revenue || 0,
            orderCount: values.get(month.month)?.orderCount || 0,
        }));
    }, [data, monthLabels]);

    return (
        <>
            <AdminNav />
            <main className="container admin-page admin-analytics-page">
                <div className="page-title-row admin-page-heading">
                    <div><p className="admin-eyebrow">REPORTING</p><h1>Analytics</h1><p className="admin-section-description">Revenue totals based on current order records.</p></div>
                    <Link href="/admin/dashboard" className="btn btn-secondary">Back to Dashboard</Link>
                </div>

                {loading ? <p role="status">Loading analytics...</p> : error ? (
                    <p role="alert" className="error-message">{error}</p>
                ) : data && (
                    <div className="admin-analytics-grid">
                        <div className="card admin-metric-card">
                            <h3>Total Revenue</h3>
                            <p className="admin-metric-value">₹{data.metrics.totalRevenue}</p>
                        </div>
                        <div className="card admin-metric-card">
                            <h3>Completed Revenue</h3>
                            <p className="admin-metric-value admin-metric-value--success">₹{data.metrics.completedRevenue}</p>
                        </div>
                        <div className="card admin-metric-card">
                            <h3>Pending Revenue</h3>
                            <p className="admin-metric-value admin-metric-value--pending">₹{data.metrics.pendingRevenue}</p>
                        </div>
                        <div className="card admin-metric-card">
                            <h3>This Month</h3>
                            <p className="admin-metric-value admin-metric-value--accent">₹{data.metrics.thisMonthRevenue}</p>
                        </div>
                    </div>
                )}

                <div className="admin-analytics-chart-stack">
                    <RevenueOverview loading={loading} error={error} points={revenuePoints} />
                    <OrderStatistics loading={loading} error={error} data={data} />
                </div>
            </main>
        </>
    );
}

