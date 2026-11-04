'use client';

import BrandMark from '@/components/BrandMark';
import { interpretRegistrationOtpResponse } from '@/lib/registration-otp-response';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function WriterSignupPage() {
    const router = useRouter();
    const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [registrationStep, setRegistrationStep] = useState<'details' | 'verification'>('details');
    const [registrationId, setRegistrationId] = useState('');
    const [verificationCode, setVerificationCode] = useState('');
    const [existingAccountConflict, setExistingAccountConflict] = useState(false);
    const [loading, setLoading] = useState(false);
    const [existingCustomer, setExistingCustomer] = useState<{ name: string; email: string; applicationStatus: string } | null>(null);

    useEffect(() => {
        fetch('/api/writer/application', { cache: 'no-store' })
            .then(async (response) => response.ok ? response.json() : null)
            .then((result) => {
                if (result?.role === 'user') {
                    setExistingCustomer({ name: result.name, email: result.email, applicationStatus: result.applicationStatus });
                }
            })
            .catch(() => {});
    }, []);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');
        setNotice('');
        setExistingAccountConflict(false);
        if (!existingCustomer && form.password !== form.confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        if (!existingCustomer && registrationStep === 'details') {
            await requestCode();
            return;
        }
        if (!existingCustomer && !/^\d{6}$/.test(verificationCode)) {
            setError('Enter the six-digit verification code');
            return;
        }

        setLoading(true);
        try {
            const response = await fetch('/api/writer/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(existingCustomer ? {} : {
                    name: form.name,
                    email: form.email,
                    password: form.password,
                    code: verificationCode,
                    registrationId,
                }),
            });
            const result = await response.json();
            if (!response.ok) {
                setExistingAccountConflict(result.existingCustomer === true);
                setError(result.error || 'Could not submit application');
                return;
            }
            if (result.user?.role === 'user') {
                setExistingCustomer({
                    name: result.user.name,
                    email: result.user.email,
                    applicationStatus: result.user.applicationStatus,
                });
            } else {
                router.push('/writer/dashboard');
            }
        } catch {
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
            const response = await fetch('/api/registration/otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role: 'writer',
                    name: form.name,
                    email: form.email,
                    password: form.password,
                    ...(resend ? { registrationId } : {}),
                }),
            });
            const result = await response.json();
            const outcome = interpretRegistrationOtpResponse(response.status, result);
            if (!outcome.accepted) {
                setError(outcome.message);
                return;
            }
            if (!resend) {
                setRegistrationId(outcome.registrationId);
                setRegistrationStep('verification');
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
                    <nav><Link href="/writer/login">Writer Login</Link></nav>
                </div>
            </header>
            <main className="container writer-auth-page">
                <div className="card writer-auth-card">
                    <h2 style={{ textAlign: 'center', marginBottom: '0.5rem' }}>Apply to Write</h2>
                    <p style={{ textAlign: 'center', color: '#6B7280', marginBottom: '2rem' }}>
                        {existingCustomer
                            ? 'Apply with your existing customer account. Your customer access and orders remain unchanged.'
                            : 'Create an applicant account. Writer features and assignments are available only after admin approval.'}
                    </p>
                    {error && <div className="error-message">{error}{existingAccountConflict && <> <Link href="/user/login?next=%2Fwriter%2Fsignup">Customer login</Link></>}</div>}
                    {notice && <div className="success-message" role="status">{notice}</div>}
                    {existingCustomer?.applicationStatus === 'pending' && <div className="success-message" role="status">Your writer application is pending admin review.</div>}
                    {existingCustomer?.applicationStatus === 'approved' && <div className="success-message" role="status">Your writer application is approved. <Link href="/writer/dashboard">Open writer dashboard</Link></div>}
                    {existingCustomer?.applicationStatus === 'rejected' && <div className="error-message" role="status">Your previous application was rejected. You may submit a new application.</div>}
                    {existingCustomer?.applicationStatus === 'not_applied' && (
                        <div className="success-message" role="status">Signed in as {existingCustomer.name} ({existingCustomer.email}). Applying will not change your customer account.</div>
                    )}
                    {(!existingCustomer || existingCustomer.applicationStatus === 'not_applied' || existingCustomer.applicationStatus === 'rejected') && <form onSubmit={handleSubmit}>
                        {!existingCustomer && <>
                        {registrationStep === 'details' && <>
                        <div className="form-group">
                            <label htmlFor="writer-signup-name">Full Name <span className="required">*</span></label>
                            <input id="writer-signup-name" name="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} autoComplete="name" maxLength={100} required />
                        </div>
                        <div className="form-group">
                            <label htmlFor="writer-signup-email">Email Address <span className="required">*</span></label>
                            <input id="writer-signup-email" type="email" name="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} autoComplete="email" maxLength={254} required />
                        </div>
                        <div className="form-group">
                            <label htmlFor="writer-signup-password">Password <span className="required">*</span></label>
                            <input id="writer-signup-password" type="password" name="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete="new-password" minLength={6} maxLength={128} required />
                        </div>
                        <div className="form-group">
                            <label htmlFor="writer-signup-confirm-password">Confirm Password <span className="required">*</span></label>
                            <input id="writer-signup-confirm-password" type="password" name="confirmPassword" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} autoComplete="new-password" required />
                        </div>
                        </>}
                        {registrationStep === 'verification' && <div className="form-group">
                            <label htmlFor="writer-verification-code">Email verification code <span className="required">*</span></label>
                            <input id="writer-verification-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required />
                            <small>Enter the six-digit code sent to the email address above.</small>
                        </div>}
                        </>}
                        <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
                            {loading ? 'Please wait...' : existingCustomer ? 'Submit Writer Application' : registrationStep === 'details' ? 'Send verification code' : 'Verify and create applicant account'}
                        </button>
                        {!existingCustomer && registrationStep === 'verification' && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem' }}>
                            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => { setRegistrationStep('details'); setNotice(''); setVerificationCode(''); }}>Edit details</button>
                            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => requestCode(true)}>Resend code</button>
                        </div>}
                    </form>}
                    <p style={{ textAlign: 'center', marginTop: '1.5rem', color: '#6B7280' }}>
                        Already applied? <Link href="/writer/login" style={{ color: '#DC2626', fontWeight: 600 }}>Sign in</Link>
                    </p>
                </div>
            </main>
        </>
    );
}
