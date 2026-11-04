import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import OrderModel from '@/lib/models/Order';
import {
    buildAdminAnalyticsPipeline,
    normalizeAdminAnalyticsResult,
} from '@/lib/admin-analytics';

const period = {
    rangeStart: new Date('2025-12-01T00:00:00.000Z'),
    currentMonthStart: new Date('2026-11-01T00:00:00.000Z'),
    rangeEnd: new Date('2026-12-01T00:00:00.000Z'),
    timeZone: 'UTC',
};

let mongo: MongoMemoryReplSet | undefined;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mongoTestDataRoot = resolve(projectRoot, '.mongodb-test-data');
const mongoTestRunToken = randomUUID();
const mongoTestRunDirectory = resolve(mongoTestDataRoot, `run-${process.pid}-${mongoTestRunToken}`);
const mongoTestDbPath = resolve(mongoTestRunDirectory, 'admin-analytics');
const mongoTestDatabaseName = `writing_xpress_analytics_test_${mongoTestRunToken.replaceAll('-', '')}`;
let mongoTestDbPathCreated = false;

beforeAll(async () => {
    await mkdir(mongoTestDataRoot, { recursive: true });
    await mkdir(mongoTestRunDirectory, { recursive: true });
    const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
    if (relativeDbPath !== `run-${process.pid}-${mongoTestRunToken}${sep}admin-analytics`) {
        throw new Error('Refusing to create an unexpected analytics test database path');
    }
    await mkdir(mongoTestDbPath);
    mongoTestDbPathCreated = true;
    mongo = await MongoMemoryReplSet.create({
        instanceOpts: [{ dbPath: mongoTestDbPath }],
        replSet: { count: 1, ip: '127.0.0.1', dbName: 'admin_analytics_test', storageEngine: 'wiredTiger' },
    });
    await mongoose.connect(mongo.getUri(mongoTestDatabaseName));
});

beforeEach(async () => {
    await OrderModel.deleteMany({});
});

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
    if (mongoTestDbPathCreated) {
        const relativeDbPath = relative(mongoTestDataRoot, mongoTestDbPath);
        if (relativeDbPath !== `run-${process.pid}-${mongoTestRunToken}${sep}admin-analytics`) {
            throw new Error('Refusing to remove an unexpected analytics test database path');
        }
        const relativeRunDirectory = relative(mongoTestDataRoot, mongoTestRunDirectory);
        if (relativeRunDirectory !== `run-${process.pid}-${mongoTestRunToken}`) {
            throw new Error('Refusing to remove an unexpected analytics test run directory');
        }
        await rm(mongoTestRunDirectory, { recursive: true });
        mongoTestDbPathCreated = false;
    }
});

describe('admin analytics MongoDB aggregation', () => {
    it('calculates revenue by creation month and counts the Order model statuses', async () => {
        await OrderModel.collection.insertMany([
            { orderId: 'WX-20251201-0001', orderStatus: 'Submitted', createdDate: '2025-12-15T12:00:00.000Z', priceAmount: 100 },
            { orderId: 'WX-20260101-0001', orderStatus: 'In Progress', createdDate: '2026-01-15T12:00:00.000Z', priceAmount: 50 },
            { orderId: 'WX-20261101-0001', orderStatus: 'Completed', createdDate: '2026-11-02T12:00:00.000Z', priceAmount: 250 },
            { orderId: 'WX-20260801-0001', orderStatus: 'Submitted', createdDate: '2026-08-05T12:00:00.000Z', priceAmount: 'invalid' },
            { orderId: 'WX-LEGACY-0001', orderStatus: 'Completed', createdDate: 'not-a-date', priceAmount: 500 },
            { orderId: 'WX-20260801-0002', orderStatus: 'Submitted', createdDate: '2026-08-20T12:00:00.000Z', priceAmount: '75' },
            { orderId: 'WX-20260901-0001', orderStatus: 'In Progress', createdDate: '2026-09-10T12:00:00.000Z' },
        ] as never[]);

        const [raw] = await OrderModel.aggregate(buildAdminAnalyticsPipeline(period));
        const result = normalizeAdminAnalyticsResult(raw);

        expect(result.metrics).toEqual({
            totalRevenue: 975,
            completedRevenue: 750,
            pendingRevenue: 225,
            thisMonthRevenue: 250,
        });
        expect(result.monthlyRevenue).toEqual([
            { month: '2025-12', revenue: 100, orderCount: 1 },
            { month: '2026-01', revenue: 50, orderCount: 1 },
            { month: '2026-08', revenue: 75, orderCount: 2 },
            { month: '2026-09', revenue: 0, orderCount: 1 },
            { month: '2026-11', revenue: 250, orderCount: 1 },
        ]);
        expect(result.orderStatistics).toEqual([
            { status: 'Submitted', count: 3 },
            { status: 'In Progress', count: 2 },
            { status: 'Completed', count: 2 },
        ]);
    });

    it('returns zero metrics, no monthly points and zero status counts for an empty collection', async () => {
        const [raw] = await OrderModel.aggregate(buildAdminAnalyticsPipeline(period));
        const result = normalizeAdminAnalyticsResult(raw);

        expect(result.metrics).toEqual({ totalRevenue: 0, completedRevenue: 0, pendingRevenue: 0, thisMonthRevenue: 0 });
        expect(result.monthlyRevenue).toEqual([]);
        expect(result.orderStatistics).toEqual([
            { status: 'Submitted', count: 0 },
            { status: 'In Progress', count: 0 },
            { status: 'Completed', count: 0 },
        ]);
    });
});
