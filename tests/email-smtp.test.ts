import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const smtpState = vi.hoisted(() => ({
    response: { accepted: ['private-recipient@example.test'], rejected: [] as string[], messageId: 'mock-id' } as unknown,
    thrown: undefined as unknown,
    calls: [] as Array<{ from: string; to: string; subject: string; text: string; html: string }>,
    transportOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('nodemailer', () => ({
    default: {
        createTransport: (options: Record<string, unknown>) => {
            smtpState.transportOptions.push(options);
            return {
                sendMail: async (message: { from: string; to: string; subject: string; text: string; html: string }) => {
                    smtpState.calls.push(message);
                    if (smtpState.thrown !== undefined) throw smtpState.thrown;
                    return smtpState.response;
                },
                close: () => {},
            };
        },
    },
}));

import { sendOtpEmail, sendWorkflowEmail } from '@/lib/email';

const SMTP_PASS_SENTINEL = 'private-smtp-password-sentinel';
const SENDER_SENTINEL = 'private-sender@example.test';
const RECIPIENT_SENTINEL = 'private-recipient@example.test';
const OTP_SENTINEL = '739184';
const RAW_ERROR_SENTINEL = `private SMTP response ${SMTP_PASS_SENTINEL} ${SENDER_SENTINEL} ${RECIPIENT_SENTINEL} ${OTP_SENTINEL}`;

beforeEach(() => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.test');
    vi.stubEnv('SMTP_PORT', '465');
    vi.stubEnv('SMTP_USER', 'mock-user@example.test');
    vi.stubEnv('SMTP_PASS', SMTP_PASS_SENTINEL);
    vi.stubEnv('SMTP_FROM', `Test Sender <${SENDER_SENTINEL}>`);
    vi.stubEnv('APP_BASE_URL', 'https://writing-xpress.example');
    smtpState.response = { accepted: [RECIPIENT_SENTINEL], rejected: [], messageId: 'mock-id' };
    smtpState.thrown = undefined;
    smtpState.calls.length = 0;
    smtpState.transportOptions.length = 0;
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

async function assertSafeOtpFailure(error: unknown, category: string, statusCode: number | null, result: string) {
    smtpState.thrown = error;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const actual = await sendOtpEmail({
        to: RECIPIENT_SENTINEL,
        purpose: 'registration',
        code: OTP_SENTINEL,
        idempotencyKey: `smtp-test-${Math.random()}`,
    });
    expect(actual).toBe(result);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]).toEqual([
        '[email:otp_registration] SMTP send failed',
        { category, statusCode },
    ]);
    const renderedLog = JSON.stringify(warn.mock.calls);
    for (const sensitive of [RAW_ERROR_SENTINEL, SMTP_PASS_SENTINEL, SENDER_SENTINEL, RECIPIENT_SENTINEL, OTP_SENTINEL]) {
        expect(renderedLog).not.toContain(sensitive);
    }
}

describe('shared Gmail SMTP email service', () => {
    it('sends OTP and workflow messages through one secure port-465 transport', async () => {
        expect(await sendOtpEmail({ to: RECIPIENT_SENTINEL, purpose: 'registration', code: OTP_SENTINEL, idempotencyKey: 'otp-success' })).toBe('accepted');
        expect(smtpState.calls[0]).toMatchObject({
            from: `Test Sender <${SENDER_SENTINEL}>`, to: RECIPIENT_SENTINEL,
            subject: 'Your WRITING-XPRESS verification code', text: expect.stringContaining(OTP_SENTINEL),
        });
        expect(smtpState.calls[0].html).toContain('WRITING-XPRESS');
        expect(smtpState.calls[0].html).toContain(OTP_SENTINEL);
        expect(smtpState.transportOptions[0]).toMatchObject({
            host: 'smtp.example.test', port: 465, secure: true,
            auth: { user: 'mock-user@example.test', pass: SMTP_PASS_SENTINEL },
        });
        expect(await sendWorkflowEmail({ event: 'order_submitted', to: RECIPIENT_SENTINEL, subject: 'Original subject', text: 'Original body', action: { label: 'Track Your Order', path: '/track?orderId=WX-20261102-0001' }, idempotencyKey: 'workflow-success' })).toBe('accepted');
        expect(smtpState.calls[1]).toMatchObject({ subject: 'Original subject', text: expect.stringContaining('Original body') });
        expect(smtpState.calls[1].text).toContain('https://writing-xpress.example/track?orderId=WX-20261102-0001');
        expect(smtpState.calls[1].html).toContain('https://writing-xpress.example/track?orderId=WX-20261102-0001');
        expect(smtpState.calls[1].html).toContain('Track Your Order');
        expect(smtpState.transportOptions).toHaveLength(1);
    });

    it('includes the dynamic Track Your Order button and plain-text link for a configured local app URL', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubEnv('APP_BASE_URL', 'http://localhost:3000');
        const orderId = 'WX-20261103-0042';
        const url = `http://localhost:3000/track?orderId=${orderId}`;
        expect(await sendWorkflowEmail({
            event: 'order_submitted',
            to: RECIPIENT_SENTINEL,
            subject: `Order received: ${orderId}`,
            text: `We received order ${orderId}.`,
            action: { label: 'Track Your Order', path: `/track?orderId=${encodeURIComponent(orderId)}` },
            idempotencyKey: `order-submitted-local/${orderId}`,
        })).toBe('accepted');

        expect(smtpState.calls[0].html).toContain(`<a href="${url}"`);
        expect(smtpState.calls[0].html).toContain('>Track Your Order</a>');
        expect(smtpState.calls[0].text).toContain(`Track Your Order: ${url}`);
    });

    it('renders the admin new-order heading, View Order button and matching plain-text link', async () => {
        const orderId = 'WX-20261104-0042';
        const url = `https://writing-xpress.example/admin/order/${orderId}`;
        expect(await sendWorkflowEmail({
            event: 'admin_new_order',
            to: 'writingxpress.online@gmail.com',
            subject: 'New Order Received – WRITING-XPRESS',
            heading: 'A New Order Has Been Placed!',
            text: `Order ID: ${orderId}\nCustomer name: Example Customer`,
            action: { label: 'View Order', path: `/admin/order/${orderId}` },
            idempotencyKey: `admin-new-order/${orderId}`,
        })).toBe('accepted');

        expect(smtpState.calls[0]).toMatchObject({ to: 'writingxpress.online@gmail.com', subject: 'New Order Received – WRITING-XPRESS' });
        expect(smtpState.calls[0].html).toContain('<h1');
        expect(smtpState.calls[0].html).toContain('A New Order Has Been Placed!');
        expect(smtpState.calls[0].html).toContain(`<a href="${url}"`);
        expect(smtpState.calls[0].html).toContain('>View Order</a>');
        expect(smtpState.calls[0].text).toContain(`View Order: ${url}`);
    });

    it('classifies SMTP authentication failures without logging raw details', async () => {
        await assertSafeOtpFailure(Object.assign(new Error(RAW_ERROR_SENTINEL), { code: 'EAUTH', responseCode: 535 }), 'authentication', 535, 'rejected');
    });

    it('classifies connection failures as ambiguous OTP delivery', async () => {
        await assertSafeOtpFailure(Object.assign(new Error(RAW_ERROR_SENTINEL), { code: 'ECONNECTION' }), 'connection', null, 'unknown');
    });

    it('classifies recipient rejection safely', async () => {
        await assertSafeOtpFailure(Object.assign(new Error(RAW_ERROR_SENTINEL), { code: 'EENVELOPE', command: 'RCPT TO', rejected: [RECIPIENT_SENTINEL] }), 'recipient_rejection', null, 'rejected');
    });

    it('returns unavailable without SMTP configuration', async () => {
        delete process.env.SMTP_PASS;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await sendOtpEmail({ to: RECIPIENT_SENTINEL, purpose: 'registration', code: OTP_SENTINEL, idempotencyKey: 'no-config' })).toBe('unavailable');
        expect(warn).toHaveBeenCalledWith('[email:otp_registration] SMTP configuration unavailable', { category: 'configuration' });
        expect(smtpState.calls).toHaveLength(0);
    });

    it('returns unknown for malformed SMTP error shapes and does not log their contents', async () => {
        await assertSafeOtpFailure(RAW_ERROR_SENTINEL, 'unknown', null, 'unknown');
    });

    it('returns failed for workflow exceptions and keeps logs free of message content', async () => {
        smtpState.thrown = Object.assign(new Error(RAW_ERROR_SENTINEL), { code: 'ETIMEDOUT' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await sendWorkflowEmail({ event: 'order_submitted', to: RECIPIENT_SENTINEL, subject: RAW_ERROR_SENTINEL, text: RAW_ERROR_SENTINEL, idempotencyKey: 'workflow-error' })).toBe('failed');
        const renderedLog = JSON.stringify(warn.mock.calls);
        for (const sensitive of [RAW_ERROR_SENTINEL, SMTP_PASS_SENTINEL, SENDER_SENTINEL, RECIPIENT_SENTINEL, OTP_SENTINEL]) expect(renderedLog).not.toContain(sensitive);
    });

    it('handles unexpected successful response shapes safely as failed delivery', async () => {
        smtpState.response = null;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await sendWorkflowEmail({ event: 'order_submitted', to: RECIPIENT_SENTINEL, subject: 's', text: 't', idempotencyKey: 'workflow-bad-shape' })).toBe('failed');
        expect(warn).toHaveBeenCalledWith('[email:order_submitted] SMTP send failed', { category: 'unknown', statusCode: null });
    });

    it('suppresses repeated workflow notifications by idempotency key in this process', async () => {
        const email = { event: 'approved_work_delivered' as const, to: RECIPIENT_SENTINEL, subject: 'Delivery', text: 'Delivered', idempotencyKey: 'same-workflow-key' };
        expect(await sendWorkflowEmail(email)).toBe('accepted');
        expect(await sendWorkflowEmail(email)).toBe('accepted');
        expect(smtpState.calls).toHaveLength(1);
    });

    it('coalesces concurrent sends with the same workflow idempotency key', async () => {
        const email = { event: 'order_assigned' as const, to: RECIPIENT_SENTINEL, subject: 'Assigned', text: 'Assigned', idempotencyKey: 'same-concurrent-key' };
        const results = await Promise.all([sendWorkflowEmail(email), sendWorkflowEmail(email)]);
        expect(results).toEqual(['accepted', 'accepted']);
        expect(smtpState.calls).toHaveLength(1);
    });
});
