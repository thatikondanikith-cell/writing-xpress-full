'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import BrandMark from '@/components/BrandMark';

const links = [
    { href: '/admin/dashboard', label: 'Dashboard', key: 'dashboard' },
    { href: '/admin/writers', label: 'Writers', key: 'writers' },
    { href: '/admin/dashboard#submissions', label: 'Reviews', key: 'reviews' },
    { href: '/admin/analytics', label: 'Analytics', key: 'analytics' },
] as const;

export default function AdminNav() {
    const pathname = usePathname();
    const router = useRouter();
    const [hasPendingReviews, setHasPendingReviews] = useState(false);
    const activeKey = pathname.startsWith('/admin/writers')
        ? 'writers'
        : pathname.startsWith('/admin/writer-review')
            ? 'reviews'
            : pathname.startsWith('/admin/analytics')
                ? 'analytics'
                : 'dashboard';

    useEffect(() => {
        let active = true;
        let requestInFlight = false;
        const refreshReviewNotification = async () => {
            if (!active || document.visibilityState !== 'visible' || requestInFlight) return;
            requestInFlight = true;
            try {
                const response = await fetch('/api/admin/submissions', { cache: 'no-store' });
                if (!response.ok) return;
                const submissions: unknown = await response.json();
                if (active) setHasPendingReviews(Array.isArray(submissions) && submissions.length > 0);
            } catch {
                // Preserve the last known notification state when the queue is temporarily unavailable.
            } finally {
                requestInFlight = false;
            }
        };

        void refreshReviewNotification();
        const timer = window.setInterval(refreshReviewNotification, 30_000);
        window.addEventListener('focus', refreshReviewNotification);
        document.addEventListener('visibilitychange', refreshReviewNotification);
        return () => {
            active = false;
            window.clearInterval(timer);
            window.removeEventListener('focus', refreshReviewNotification);
            document.removeEventListener('visibilitychange', refreshReviewNotification);
        };
    }, []);

    const logout = async () => {
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST' });
            if (response.ok) router.push('/admin/login');
        } catch {
            // Keep the current page and session visible if logout cannot reach the API.
        }
    };

    return (
        <header className="header admin-header">
            <div className="header-content">
                <BrandMark href="/admin/dashboard" label="Writing Xpress admin dashboard" />
                <nav className="admin-nav" aria-label="Admin navigation">
                    {links.map((link) => (
                        <Link
                            key={link.key}
                            href={link.href}
                            className={`admin-nav-link${activeKey === link.key ? ' active' : ''}`}
                            aria-current={activeKey === link.key ? 'page' : undefined}
                        >
                            {link.label}
                            {link.key === 'reviews' && hasPendingReviews && (
                                <span className="admin-review-notification-dot" aria-hidden="true" />
                            )}
                        </Link>
                    ))}
                    <button type="button" className="admin-nav-logout" onClick={logout}>Log out</button>
                </nav>
            </div>
        </header>
    );
}
