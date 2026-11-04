'use client';

import BrandMark from '@/components/BrandMark';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function WriterLoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');
        setLoading(true);
        try {
            const response = await fetch('/api/user/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            const result = await response.json();
            if (!response.ok) {
                setError(result.error || 'Login failed');
                return;
            }
            if (!result.user?.applicationStatus && result.user?.role !== 'writer') {
                setError('This account has no writer application. Apply first or use customer login.');
                return;
            }
            router.push(result.user?.role === 'writer' || result.user?.writerAccess ? '/writer/dashboard' : '/writer/signup');
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <header className="header compact-mobile-header">
                <div className="header-content">
                    <BrandMark />
                    <nav>
                        <Link href="/">Home</Link>
                        <Link href="/writer/signup">Apply to Write</Link>
                    </nav>
                </div>
            </header>
            <main className="container writer-auth-page">
                <div className="card writer-auth-card">
                    <h2 style={{ textAlign: 'center' }}>Writer Applicant Login</h2>
                    {error && <div className="error-message">{error}</div>}
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label htmlFor="writer-login-email">Email Address</label>
                            <input id="writer-login-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
                        </div>
                        <div className="form-group">
                            <label htmlFor="writer-login-password">Password</label>
                            <input id="writer-login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
                        </div>
                        <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
                            {loading ? 'Signing in...' : 'Sign In'}
                        </button>
                    </form>
                </div>
            </main>
        </>
    );
}
