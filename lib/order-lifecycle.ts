import type { OrderStatus } from './types';

/** Status changes allowed through the normal admin order update API. */
export function canTransitionOrderStatus(current: OrderStatus, next: OrderStatus): boolean {
    if (current === next) return true;
    if (current === 'Submitted') return next === 'In Progress';
    if (current === 'In Progress') return next === 'Completed';
    return false;
}
