'use client';

import BrandMark from '@/components/BrandMark';
import { interpretRegistrationOtpResponse } from '@/lib/registration-otp-response';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function UserSignupPage() {
    const router = useRouter();
    const [formData, setFormData] = useState({ name: '', email: '', password: '', confirmPassword: '' });
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [step, setStep] = useState<'details' | 'verification'>('details');
    const [registrationId, setRegistrationId] = useState('');
    const [code, setCode] = useState('');
    const [loading, setLoading] = useState(false);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setNotice('');

        if (!formData.name || !formData.email || !formData.password || !formData.confirmPassword) {
            setError('All fields are required');
            return;
        }

        if (formData.password !== formData.confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        if (formData.password.length < 6) {
            setError('Password must be at least 6 characters');
            return;
        }

        if (step === 'details') {
            await requestCode();
            return;
        }

        if (!/^\d{6}$/.test(code)) {
            setError('Enter the six-digit verification code');
            return;
        }
        setLoading(true);
        try {
            const res = await fetch('/api/user/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: formData.name,
                    email: formData.email,
                    password: formData.password,
                    code,
                    registrationId,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                setError(data.error || 'Unable to complete registration');
                return;
            }

            localStorage.setItem('userAuth', JSON.stringify(data.user));
            router.push('/user/dashboard');

        } catch (err) {
            setError('Something went wrong. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const requestCode = async (resend = false) => {
        setLoading(true);
        setError('');
        setNotice('');
        try {
            const res = await fetch('/api/registration/otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role: 'user',
                    name: formData.name,
                    email: formData.email,
                    password: formData.password,
                    ...(resend ? { registrationId } : {}),
                }),
            });
            const data = await res.json();
            const outcome = interpretRegistrationOtpResponse(res.status, data);
            if (!outcome.accepted) {
                setError(outcome.message);
                return;
            }
            if (!resend) {
                setRegistrationId(outcome.registrationId);
                setStep('verification');
            }
            setNotice(outcome.message);
        } catch {
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
                        <Link href="/user/login">Login</Link>
                    </nav>
                </div>
            </header>

            <div className="container">
                <div className="card" style={{ maxWidth: '480px', margin: '0 auto' }}>
                    <h2 style={{ textAlign: 'center', marginBottom: '0.5rem' }}>Create Account</h2>
                    <p style={{ textAlign: 'center', color: '#6B7280', marginBottom: '2rem', fontSize: '0.95rem' }}>
                        Sign up to track all your orders in one place
                    </p>

                    {error && <div className="error-message">{error}</div>}
                    {notice && <div className="success-message" role="status">{notice}</div>}

                    <form onSubmit={handleSubmit}>
                        {step === 'details' && <>
                        <div className="form-group">
                            <label htmlFor="customer-signup-name">Full Name <span className="required">*</span></label>
                            <input
                                id="customer-signup-name"
                                type="text"
                                name="name"
                                placeholder="Enter your full name"
                                value={formData.name}
                                onChange={handleChange}
                                autoComplete="name"
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="customer-signup-email">Email Address <span className="required">*</span></label>
                            <input
                                id="customer-signup-email"
                                type="email"
                                name="email"
                                placeholder="Enter your email"
                                value={formData.email}
                                onChange={handleChange}
                                autoComplete="email"
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="customer-signup-password">Password <span className="required">*</span></label>
                            <input
                                id="customer-signup-password"
                                type="password"
                                name="password"
                                placeholder="Minimum 6 characters"
                                value={formData.password}
                                onChange={handleChange}
                                autoComplete="new-password"
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="customer-signup-confirm-password">Confirm Password <span className="required">*</span></label>
                            <input
                                id="customer-signup-confirm-password"
                                type="password"
                                name="confirmPassword"
                                placeholder="Re-enter your password"
                                value={formData.confirmPassword}
                                onChange={handleChange}
                                autoComplete="new-password"
                            />
                        </div>
                        </>}

                        {step === 'verification' && <div className="form-group">
                            <label htmlFor="verification-code">Email verification code <span className="required">*</span></label>
                            <input id="verification-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required />
                            <small>Enter the six-digit code sent to the email address above.</small>
                        </div>}

                        <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
                            {loading ? (step === 'details' ? 'Sending code...' : 'Verifying...') : (step === 'details' ? 'Send verification code' : 'Verify and create account')}
                        </button>
                        {step === 'verification' && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem' }}>
                            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => { setStep('details'); setNotice(''); setCode(''); }}>Edit details</button>
                            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => requestCode(true)}>Resend code</button>
                        </div>}
                    </form>

                    <p style={{ textAlign: 'center', marginTop: '1.5rem', color: '#6B7280', fontSize: '0.95rem' }}>
                        Already have an account?{' '}
                        <Link href="/user/login" style={{ color: '#DC2626', fontWeight: 600, textDecoration: 'none' }}>
                            Login
                        </Link>
                    </p>
                </div>
            </div>
        </>
    );
}
