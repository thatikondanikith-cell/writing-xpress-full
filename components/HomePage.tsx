'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BrandMark from '@/components/BrandMark';
import PublicFooter from '@/components/PublicFooter';
import CustomerStories from '@/components/CustomerStories';

type UserAuth = { role: 'user' | 'writer' | 'admin' };

export default function HomePage() {
    const router = useRouter();
    const [user, setUser] = useState<UserAuth | null>(null);
    const [sessionChecked, setSessionChecked] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        let active = true;
        fetch('/api/auth/session', { cache: 'no-store' })
            .then((response) => response.ok ? response.json() : null)
            .then((result) => {
                if (!active) return;
                const role = result?.user?.role;
                setUser(role === 'user' || role === 'writer' || role === 'admin' ? { role } : null);
            })
            .catch(() => { if (active) setUser(null); })
            .finally(() => { if (active) setSessionChecked(true); });
        return () => { active = false; };
    }, []);

    const handleLogout = async () => {
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST' });
            if (!response.ok) return;
            localStorage.removeItem('userAuth');
            setUser(null);
            setSessionChecked(true);
            router.replace('/');
            router.refresh();
        } catch {
            // Keep the current display state if the server could not clear the session.
        }
    };

    const dashboardHref = user?.role === 'writer' ? '/writer/dashboard' : user?.role === 'admin' ? '/admin/dashboard' : '/user/dashboard';

    return (
        <div className="landing-page">
            <header className="header landing-header">
                <div className="header-content">
                    <BrandMark currentPage />
                    <button
                        className="menu-btn"
                        type="button"
                        onClick={() => setMenuOpen((open) => !open)}
                        aria-expanded={menuOpen}
                        aria-controls="landing-navigation"
                        aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
                    ><span /><span /><span /></button>
                    <nav id="landing-navigation" className={menuOpen ? 'mobile-nav open' : 'mobile-nav'} aria-label="Main navigation">
                        {sessionChecked && !user && <Link href="/writer/signup">Apply as writer</Link>}
                        {sessionChecked && !user ? (
                            <>
                                <Link href="/user/login">Sign in</Link>
                                <Link href="/user/signup" className="btn btn-primary">Create account</Link>
                            </>
                        ) : sessionChecked && user ? (
                            <>
                                <Link href={dashboardHref}>{user.role === 'user' ? 'My orders' : 'Dashboard'}</Link>
                                {user.role === 'user' && <Link href="/submit" className="btn btn-primary">Place an order</Link>}
                                <button type="button" className="header-logout" onClick={handleLogout}>Sign out</button>
                            </>
                        ) : null}
                        {sessionChecked && !user && <Link className="admin-login-link" href="/admin/login">Admin</Link>}
                    </nav>
                </div>
            </header>

            <main>
                <section className="landing-hero">
                    <div className="landing-hero__inner">
                        <div className="landing-hero__copy">
                            <p className="eyebrow"><span className="eyebrow__line" />Academic writing support, made clearer</p>
                            <h1>From your brief to a <span>finished draft</span>, with less friction.</h1>
                            <p className="landing-hero__lede">Share your requirements, follow your order as it moves forward, and access your delivered files from one place.</p>
                            <div className="landing-hero__actions">
                                {!sessionChecked || !user ? (
                                    <>
                                        <Link href="/user/signup" className="btn btn-primary">Get started <span aria-hidden="true">↗</span></Link>
                                        <Link href="/user/login" className="btn btn-quiet">Customer sign in</Link>
                                    </>
                                ) : user.role === 'user' ? (
                                    <>
                                        <Link href="/submit" className="btn btn-primary">Place an order <span aria-hidden="true">↗</span></Link>
                                        <Link href="/user/dashboard" className="btn btn-quiet">View my orders</Link>
                                    </>
                                ) : (
                                    <Link href={dashboardHref} className="btn btn-primary">Open {user.role} dashboard <span aria-hidden="true">↗</span></Link>
                                )}
                            </div>
                            <div className="landing-trust-note"><span className="trust-dot" /> Keep order details and delivery in one account.</div>
                        </div>
                        <div className="landing-hero__visual" role="img" aria-label="Illustration showing project requirements, progress, and delivery">
                            <div className="visual-orbit visual-orbit--one" />
                            <div className="visual-orbit visual-orbit--two" />
                            <div className="document-card document-card--back"><span /></div>
                            <div className="document-card document-card--main">
                                <div className="document-card__top"><span className="document-icon">W</span><span className="document-menu" aria-hidden="true">•••</span></div>
                                <p className="document-kicker">YOUR PROJECT</p>
                                <h2>A clear path<br />from brief to delivery</h2>
                                <div className="document-rule" />
                                <div className="progress-item"><span className="progress-check">✓</span><span><strong>Requirements shared</strong><small>Your brief is ready for review</small></span></div>
                                <div className="progress-item"><span className="progress-check progress-check--soft">02</span><span><strong>Work in progress</strong><small>Follow status from your dashboard</small></span></div>
                                <div className="progress-item progress-item--muted"><span className="progress-check progress-check--outline">03</span><span><strong>Delivery available</strong><small>Access the file when it is complete</small></span></div>
                            </div>
                            <div className="visual-stamp"><span>WX</span><small>WORKFLOW<br />AT A GLANCE</small></div>
                        </div>
                    </div>
                    <div className="landing-hero__bottom"><span>Writing Xpress</span><span className="landing-hero__bottom-rule" /><span>Clear steps. One place to follow through.</span></div>
                </section>

                <section className="landing-section landing-section--process" aria-labelledby="process-title">
                    <div className="section-heading">
                        <p className="eyebrow">A straightforward process</p>
                        <h2 id="process-title">Good work starts with a clear brief.</h2>
                        <p>Each step keeps your requirements and order information easy to find.</p>
                    </div>
                    <div className="process-grid">
                        <article className="process-card"><span className="process-card__number">01</span><div className="process-card__icon" aria-hidden="true">↗</div><h3>Tell us what you need</h3><p>Share the instructions and reference files that explain your project.</p></article>
                        <article className="process-card"><span className="process-card__number">02</span><div className="process-card__icon" aria-hidden="true">◎</div><h3>Follow your order</h3><p>Use your account or order ID to check the latest status and details.</p></article>
                        <article className="process-card"><span className="process-card__number">03</span><div className="process-card__icon" aria-hidden="true">↓</div><h3>Access the delivery</h3><p>When the order is complete, sign in to access your delivered file.</p></article>
                    </div>
                </section>

                <section className="landing-about-summary" aria-labelledby="landing-about-title">
                    <p className="eyebrow">About WRITING-XPRESS</p>
                    <h2 id="landing-about-title">Clear steps from brief to delivery.</h2>
                    <p>WRITING-XPRESS helps customers share their requirements, follow progress, and access completed work from one place.</p>
                </section>

                <CustomerStories />

                <section className="landing-cta-band">
                    <div><p className="eyebrow">A simpler next step</p><h2>Ready to share your requirements?</h2><p>Start an order or sign in to pick up where you left off.</p></div>
                    <div className="landing-cta-band__actions">
                        <Link href={user?.role === 'user' ? '/submit' : '/user/signup'} className="btn btn-light">{user?.role === 'user' ? 'Place an order' : 'Get started'} <span aria-hidden="true">↗</span></Link>
                        <Link href="/track" className="landing-cta-link">Track an existing order</Link>
                    </div>
                </section>
            </main>
            <PublicFooter />
        </div>
    );
}
