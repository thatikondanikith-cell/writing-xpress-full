import type { OrderStatus } from '@/lib/types';
import type { PipelineStage } from 'mongoose';

export const ADMIN_ANALYTICS_ORDER_STATUSES = [
    'Submitted',
    'In Progress',
    'Completed',
] as const satisfies readonly OrderStatus[];

export type AdminAnalyticsPeriod = {
    rangeStart: Date;
    currentMonthStart: Date;
    rangeEnd: Date;
    timeZone: string;
};

export type AdminAnalyticsData = {
    metrics: {
        totalRevenue: number;
        completedRevenue: number;
        pendingRevenue: number;
        thisMonthRevenue: number;
    };
    monthlyRevenue: Array<{ month: string; revenue: number; orderCount: number }>;
    orderStatistics: Array<{ status: OrderStatus; count: number }>;
};

type AggregationResult = {
    metrics?: Array<Record<string, unknown>>;
    monthlyRevenue?: Array<Record<string, unknown>>;
    orderStatistics?: Array<Record<string, unknown>>;
};

function finiteNumber(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

/** Build one compact MongoDB aggregation for the existing revenue rules and chart data. */
export function buildAdminAnalyticsPipeline(period: AdminAnalyticsPeriod): PipelineStage[] {
    const pipeline: PipelineStage[] = [
        {
            $addFields: {
                __analyticsCreatedDate: {
                    $convert: { input: '$createdDate', to: 'date', onError: null, onNull: null },
                },
                __analyticsRevenue: {
                    $convert: { input: '$priceAmount', to: 'double', onError: 0, onNull: 0 },
                },
            },
        },
        {
            $facet: {
                metrics: [
                    {
                        $group: {
                            _id: null,
                            totalRevenue: { $sum: '$__analyticsRevenue' },
                            completedRevenue: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$orderStatus', 'Completed'] },
                                        '$__analyticsRevenue',
                                        0,
                                    ],
                                },
                            },
                            pendingRevenue: {
                                $sum: {
                                    $cond: [
                                        { $ne: ['$orderStatus', 'Completed'] },
                                        '$__analyticsRevenue',
                                        0,
                                    ],
                                },
                            },
                            thisMonthRevenue: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $ne: ['$__analyticsCreatedDate', null] },
                                                { $gte: ['$__analyticsCreatedDate', period.currentMonthStart] },
                                                { $lt: ['$__analyticsCreatedDate', period.rangeEnd] },
                                            ],
                                        },
                                        '$__analyticsRevenue',
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                ],
                monthlyRevenue: [
                    {
                        $match: {
                            __analyticsCreatedDate: { $gte: period.rangeStart, $lt: period.rangeEnd },
                        },
                    },
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    format: '%Y-%m',
                                    date: '$__analyticsCreatedDate',
                                    timezone: period.timeZone,
                                },
                            },
                            revenue: { $sum: '$__analyticsRevenue' },
                            orderCount: { $sum: 1 },
                        },
                    },
                    { $sort: { _id: 1 as const } },
                    { $project: { _id: 0, month: '$_id', revenue: 1, orderCount: 1 } },
                ],
                orderStatistics: [
                    { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
                ],
            },
        },
    ];
    return pipeline;
}

/** Limit the database aggregate to public chart/metric fields and fill absent statuses with zero. */
export function normalizeAdminAnalyticsResult(result?: AggregationResult): AdminAnalyticsData {
    const rawMetrics = result?.metrics?.[0] || {};
    const counts = new Map<string, number>();
    for (const item of result?.orderStatistics || []) {
        if (typeof item._id === 'string') counts.set(item._id, finiteNumber(item.count));
    }

    return {
        metrics: {
            totalRevenue: finiteNumber(rawMetrics.totalRevenue),
            completedRevenue: finiteNumber(rawMetrics.completedRevenue),
            pendingRevenue: finiteNumber(rawMetrics.pendingRevenue),
            thisMonthRevenue: finiteNumber(rawMetrics.thisMonthRevenue),
        },
        monthlyRevenue: (result?.monthlyRevenue || []).flatMap((item) => {
            if (typeof item.month !== 'string' || !/^\d{4}-\d{2}$/.test(item.month)) return [];
            return [{
                month: item.month,
                revenue: finiteNumber(item.revenue),
                orderCount: finiteNumber(item.orderCount),
            }];
        }),
        orderStatistics: ADMIN_ANALYTICS_ORDER_STATUSES.map((status) => ({
            status,
            count: counts.get(status) || 0,
        })),
    };
}
