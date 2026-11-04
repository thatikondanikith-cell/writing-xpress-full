'use client';

import BrandMark from '@/components/BrandMark';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';


export default function AdminLoginPage() {
    const router = useRouter();
    const [credentials, setCredentials] = useState({
        username: '',
        password: '',
    });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(credentials),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Login failed');
            }
            
            router.push('/admin/dashboard');
        } catch (err: any) {
            setError(err.message || 'An error occurred during login');
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
                    </nav>
                </div>
            </header>

            <main className="container admin-login-page">
                <div className="card admin-login-card">
                    <h2 className="text-center">Admin Login</h2>

                    {error && <div className="error-message">{error}</div>}

                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label>
                                Username <span className="required">*</span>
                            </label>
                            <input
                                type="text"
                                value={credentials.username}
                                onChange={(e) => setCredentials({ ...credentials, username: e.target.value })}
                                required
                                autoComplete="username"
                            />
                        </div>

                        <div className="form-group">
                            <label>
                                Password <span className="required">*</span>
                            </label>
                            <input
                                type="password"
                                value={credentials.password}
                                onChange={(e) => setCredentials({ ...credentials, password: e.target.value })}
                                required
                                autoComplete="current-password"
                            />
                        </div>

                        <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
                            {loading ? 'Logging in...' : 'Login'}
                        </button>
                    </form>
                </div>
            </main>
        </>
    );
}
