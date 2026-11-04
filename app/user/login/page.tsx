'use client';

import BrandMark from '@/components/BrandMark';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function UserLoginPage() {
    const router = useRouter();
    const [formData, setFormData] = useState({ email: '', password: '' });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!formData.email || !formData.password) {
            setError('Email and password are required');
            return;
        }

        setLoading(true);

        try {
            const res = await fetch('/api/user/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
            });

            const data = await res.json();

            if (!res.ok) {
                setError(data.error || 'Login failed');
                return;
            }

            localStorage.setItem('userAuth', JSON.stringify(data.user));
            const next = new URLSearchParams(window.location.search).get('next');
            router.push(next === '/writer/signup' ? next : data.user.role === 'writer' ? '/writer/dashboard' : '/user/dashboard');

        } catch (err) {
            setError('Something went wrong. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <header className="header">
                <div className="header-content">
                    <BrandMark />
                    <nav>
                        <Link href="/">Home</Link>
                        <Link href="/user/signup">Sign Up</Link>
                    </nav>
                </div>
            </header>

            <div className="container">
                <div className="card" style={{ maxWidth: '480px', margin: '0 auto' }}>
                    <h2 style={{ textAlign: 'center', marginBottom: '0.5rem' }}>Welcome Back</h2>
                    <p style={{ textAlign: 'center', color: '#6B7280', marginBottom: '2rem', fontSize: '0.95rem' }}>
                        Login to view your order history
                    </p>

                    {error && <div className="error-message">{error}</div>}

                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label htmlFor="customer-login-email">Email Address</label>
                            <input
                                id="customer-login-email"
                                type="email"
                                name="email"
                                placeholder="Enter your email"
                                value={formData.email}
                                onChange={handleChange}
                                autoComplete="email"
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="customer-login-password">Password</label>
                            <input
                                id="customer-login-password"
                                type="password"
                                name="password"
                                placeholder="Enter your password"
                                value={formData.password}
                                onChange={handleChange}
                                autoComplete="current-password"
                            />
                        </div>

                        <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
                            {loading ? 'Logging in...' : 'Login'}
                        </button>
                    </form>

                    <p style={{ textAlign: 'center', marginTop: '1.5rem', color: '#6B7280', fontSize: '0.95rem' }}>
                        Don't have an account?{' '}
                        <Link href="/user/signup" style={{ color: '#DC2626', fontWeight: 600, textDecoration: 'none' }}>
                            Sign Up
                        </Link>
                    </p>
                </div>
            </div>
        </>
    );
}
