import nodemailer, { type Transporter } from 'nodemailer';
import { buildApplicationUrl, renderBrandedEmailHtml, type EmailAction } from '@/lib/email-template';

export type WorkflowEmailEvent =
    | 'order_submitted'
    | 'admin_new_order'
    | 'writer_application_submitted'
    | 'writer_application_decision'
    | 'order_assigned'
    | 'assignment_declined'
    | 'assignment_expired'
    | 'writer_submission_received'
    | 'writer_revision_requested'
    | 'writer_submission_approved'
    | 'approved_work_delivered'
    | 'physical_delivery_confirmed'
    | 'otp_registration'
    | 'otp_email_change'
    | 'otp_password_reset';

export type WorkflowEmailResult = 'accepted' | 'skipped' | 'failed';

export type OtpEmailSendResult = 'accepted' | 'rejected' | 'unavailable' | 'unknown';

export type OtpEmailPurpose = 'registration' | 'email_change' | 'password_reset';

type WorkflowEmail = {
    event: WorkflowEmailEvent;
    to?: string | null;
    subject: string;
    text: string;
    idempotencyKey: string;
    action?: EmailAction;
    heading?: string;
};

type EmailDiagnosticCategory = 'configuration' | 'authentication' | 'connection' | 'recipient_rejection' | 'smtp_rejection' | 'unknown';
type SmtpConfiguration = { host: string; port: number; user: string; pass: string; from: string };
type NodemailerError = { code?: unknown; responseCode?: unknown; command?: unknown; rejected?: unknown };

const WORKFLOW_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const acceptedWorkflowKeys = new Map<string, number>();
const inFlightWorkflowSends = new Map<string, Promise<WorkflowEmailResult>>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSmtpConfiguration(): SmtpConfiguration | null {
    const host = process.env.SMTP_HOST?.trim();
    const portValue = process.env.SMTP_PORT?.trim();
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.trim();
    const from = process.env.SMTP_FROM?.trim();
    const port = portValue ? Number(portValue) : NaN;
    if (!host || /\s/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass || !from || !isValidSender(from)) return null;
    return { host, port, user, pass, from };
}

let smtpTransport: Transporter | undefined;
let smtpTransportConfiguration: SmtpConfiguration | undefined;

function sameSmtpConfiguration(left: SmtpConfiguration | undefined, right: SmtpConfiguration): boolean {
    return Boolean(left && left.host === right.host && left.port === right.port && left.user === right.user &&
        left.pass === right.pass && left.from === right.from);
}

function getSmtpTransport(config: SmtpConfiguration): Transporter {
    // Reuse one transport per active configuration; credentials are not serialized or logged.
    if (!smtpTransport || !sameSmtpConfiguration(smtpTransportConfiguration, config)) {
        smtpTransport?.close();
        smtpTransport = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.port === 465,
            auth: { user: config.user, pass: config.pass },
        });
        smtpTransportConfiguration = config;
    }
    return smtpTransport;
}

function classifySmtpError(error: unknown): { category: EmailDiagnosticCategory; statusCode: number | null } {
    const value = isRecord(error) ? error as NodemailerError : {};
    const code = typeof value.code === 'string' ? value.code.toUpperCase() : '';
    const command = typeof value.command === 'string' ? value.command.toUpperCase() : '';
    const rawStatusCode = value.responseCode;
    const statusCode = typeof rawStatusCode === 'number' && Number.isInteger(rawStatusCode) && rawStatusCode >= 100 && rawStatusCode <= 599
        ? rawStatusCode : null;
    if (code === 'EAUTH' || statusCode === 534 || statusCode === 535) return { category: 'authentication', statusCode };
    if (command === 'RCPT TO' || code === 'EENVELOPE' || (Array.isArray(value.rejected) && value.rejected.length > 0)) {
        return { category: 'recipient_rejection', statusCode };
    }
    if (/^(ECONNECTION|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EDNS|ENOTFOUND|EHOSTUNREACH|ESOCKET|ETLS)$/.test(code)) {
        return { category: 'connection', statusCode };
    }
    return { category: statusCode === null ? 'unknown' : 'smtp_rejection', statusCode };
}

function logSmtpFailure(event: WorkflowEmailEvent, error: unknown): EmailDiagnosticCategory {
    const diagnostic = classifySmtpError(error);
    // Do not include SMTP responses, addresses, messages, headers, or credentials.
    console.warn(`[email:${event}] SMTP send failed`, diagnostic);
    return diagnostic.category;
}

function logMissingConfiguration(event: WorkflowEmailEvent): void {
    console.warn(`[email:${event}] SMTP configuration unavailable`, { category: 'configuration' });
}

function clearExpiredWorkflowKeys(now = Date.now()): void {
    for (const [key, expiresAt] of acceptedWorkflowKeys) if (expiresAt <= now) acceptedWorkflowKeys.delete(key);
}

function isEmailAddress(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidSender(value: string): boolean {
    if (/[\r\n]/.test(value)) return false;
    const bracketedAddress = value.match(/<([^<>]+)>\s*$/)?.[1];
    return isEmailAddress(bracketedAddress ?? value);
}

/**
 * Sends branded HTML and plain-text workflow notifications. Failures are logged
 * without email content and never thrown into the workflow that triggered them.
 */
async function sendConfiguredEmail(email: WorkflowEmail): Promise<WorkflowEmailResult> {
    const config = getSmtpConfiguration();
    const to = typeof email.to === 'string' ? email.to.trim() : '';
    if (!config) {
        logMissingConfiguration(email.event);
        return 'skipped';
    }
    if (!to || !isEmailAddress(to)) {
        console.warn(`[email:${email.event}] skipped; invalid recipient configuration`);
        return 'skipped';
    }

    try {
        const actionUrl = email.action ? buildApplicationUrl(email.action.path) : null;
        const html = renderBrandedEmailHtml(email.subject, email.text, actionUrl && email.action
            ? { label: email.action.label, url: actionUrl }
            : undefined, email.heading);
        const response = await getSmtpTransport(config).sendMail({
            from: config.from,
            to,
            subject: email.subject,
            text: actionUrl && email.action ? `${email.text}\n\n${email.action.label}: ${actionUrl}` : email.text,
            html,
        });
        if (!isRecord(response) || !Array.isArray(response.accepted) || !Array.isArray(response.rejected)) {
            logSmtpFailure(email.event, null);
            return 'failed';
        }
        if (response.accepted.length > 0) return 'accepted';
        logSmtpFailure(email.event, { command: 'RCPT TO', rejected: response.rejected });
        return 'failed';
    } catch (error) {
        logSmtpFailure(email.event, error);
        return 'failed';
    }
}

export async function sendWorkflowEmail(email: WorkflowEmail): Promise<WorkflowEmailResult> {
    clearExpiredWorkflowKeys();
    const cachedExpiry = acceptedWorkflowKeys.get(email.idempotencyKey);
    if (cachedExpiry && cachedExpiry > Date.now()) return 'accepted';
    const existing = inFlightWorkflowSends.get(email.idempotencyKey);
    if (existing) return existing;

    const send = sendConfiguredEmail(email).then((result) => {
        if (result === 'accepted') acceptedWorkflowKeys.set(email.idempotencyKey, Date.now() + WORKFLOW_IDEMPOTENCY_WINDOW_MS);
        return result;
    }).finally(() => inFlightWorkflowSends.delete(email.idempotencyKey));
    inFlightWorkflowSends.set(email.idempotencyKey, send);
    return send;
}

export function hasOtpEmailConfiguration(): boolean {
    return getSmtpConfiguration() !== null;
}

/** Sends an OTP through the shared SMTP transport without logging its content. */
export async function sendOtpEmail(email: {
    to: string;
    purpose: OtpEmailPurpose;
    code: string;
    idempotencyKey: string;
}): Promise<OtpEmailSendResult> {
    const labels: Record<OtpEmailPurpose, string> = {
        registration: 'finish creating your WRITING-XPRESS account',
        email_change: 'confirm the email address change requested for your account',
        password_reset: 'reset your WRITING-XPRESS account password',
    };
    const config = getSmtpConfiguration();
    const event = `otp_${email.purpose}` as WorkflowEmailEvent;
    if (!config) {
        logMissingConfiguration(event);
        return 'unavailable';
    }

    try {
        const subject = 'Your WRITING-XPRESS verification code';
        const text = `Use this code to ${labels[email.purpose]}: ${email.code}\n\nThis code expires in 5 minutes. If you did not request it, you can ignore this email.`;
        const response = await getSmtpTransport(config).sendMail({
            from: config.from,
            to: email.to,
            subject,
            text,
            html: renderBrandedEmailHtml(subject, text),
        });
        if (!isRecord(response) || !Array.isArray(response.accepted) || !Array.isArray(response.rejected)) {
            logSmtpFailure(event, null);
            return 'unknown';
        }
        if (response.accepted.length === 0) {
            logSmtpFailure(event, { command: 'RCPT TO', rejected: response.rejected });
            return 'rejected';
        }
        return 'accepted';
    } catch (error) {
        const category = logSmtpFailure(event, error);
        // A transport timeout can be ambiguous: the SMTP server may have accepted the message.
        return category === 'connection' || category === 'unknown' ? 'unknown' : 'rejected';
    }
}

export function getAdminNotificationEmail(): string | undefined {
    const email = process.env.ADMIN_NOTIFICATION_EMAIL?.trim();
    return email && isEmailAddress(email) ? email : undefined;
}
