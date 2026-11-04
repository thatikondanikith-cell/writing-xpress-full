import { describe, expect, it } from 'vitest';
import { canTransitionOrderStatus } from '@/lib/order-lifecycle';

describe('order status transitions', () => {
    it.each([
        ['Submitted', 'Submitted', true],
        ['Submitted', 'In Progress', true],
        ['Submitted', 'Completed', false],
        ['In Progress', 'In Progress', true],
        ['In Progress', 'Submitted', false],
        ['In Progress', 'Completed', true],
        ['Completed', 'Completed', true],
        ['Completed', 'Submitted', false],
        ['Completed', 'In Progress', false],
    ] as const)('%s → %s is %s', (current, next, allowed) => {
        expect(canTransitionOrderStatus(current, next)).toBe(allowed);
    });
});
