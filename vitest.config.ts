import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    // Vitest must not load the application's .env.local or other project secrets.
    envDir: `${projectRoot}/tests/env-empty`,
    resolve: {
        alias: { '@': projectRoot },
    },
    test: {
        include: ['tests/email-smtp.test.ts', 'tests/email-template.test.ts', 'tests/order-confirmation.test.ts', 'tests/registration-otp.integration.test.ts', 'tests/order-id-counter.integration.test.ts', 'tests/upload-abuse.integration.test.ts', 'tests/customer-upload-ownership.integration.test.ts', 'tests/file-validation.test.ts', 'tests/order-lifecycle.test.ts', 'tests/writer-assignment-acceptance.test.ts', 'tests/physical-delivery.test.ts', 'tests/admin-order-pagination.test.ts', 'tests/customer-order-pagination.test.ts', 'tests/writer-workspace-active-count.test.ts', 'tests/admin-analytics.test.ts', 'tests/admin-analytics-aggregation.integration.test.ts'],
        environment: 'node',
        fileParallelism: false,
        maxWorkers: 1,
        minWorkers: 1,
        testTimeout: 30_000,
        hookTimeout: 60_000,
        restoreMocks: true,
        clearMocks: true,
    },
});
