export type EmailAction = { label: string; path: string };

function isLocalHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1' ||
        normalized === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isAllowedActionUrl(value: string): boolean {
    if (!value || /[\r\n]/.test(value)) return false;
    try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        if (url.protocol === 'https:') return true;
        return process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && isLocalHostname(url.hostname);
    } catch {
        return false;
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Resolve an internal app path only against an explicitly configured public app URL. */
export function buildApplicationUrl(path: string): string | null {
    const base = process.env.APP_BASE_URL?.trim();
    if (!base || !path.startsWith('/') || path.startsWith('//')) return null;

    try {
        const baseUrl = new URL(base);
        if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') return null;
        if (baseUrl.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && baseUrl.protocol === 'http:' && isLocalHostname(baseUrl.hostname))) return null;
        const target = new URL(path, baseUrl);
        if (target.origin !== baseUrl.origin || !isAllowedActionUrl(target.toString())) return null;
        return target.toString();
    } catch {
        return null;
    }
}

export function renderBrandedEmailHtml(subject: string, text: string, action?: { label: string; url: string }, heading?: string): string {
    const paragraphs = text.split(/\n\s*\n/).map((paragraph) =>
        `<p style="margin:0 0 16px;color:#172B3A;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`
    ).join('');
    const safeAction = action && isAllowedActionUrl(action.url)
        ? `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:24px 0 8px;"><tr><td align="center" bgcolor="#E64B45" style="border-radius:8px;"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:13px 22px;border:1px solid #E64B45;border-radius:8px;background-color:#E64B45;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:1.2;text-align:center;text-decoration:none;">${escapeHtml(action.label)}</a></td></tr></table>`
        : '';
    const safeSubject = escapeHtml(subject);
    const safeHeading = escapeHtml(heading || subject);

    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${safeSubject}</title></head>
<body style="margin:0;padding:0;background-color:#F5F1E8;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#F5F1E8" style="width:100%;background-color:#F5F1E8;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;">
        <tr><td style="padding:0 8px 18px;color:#172B3A;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;letter-spacing:.04em;">WRITING-XPRESS</td></tr>
        <tr><td bgcolor="#FFFFFF" style="padding:32px 30px;border:1px solid #E7E9EC;border-radius:14px;background-color:#FFFFFF;">
          <h1 style="margin:0 0 22px;color:#172B3A;font-family:Arial,Helvetica,sans-serif;font-size:23px;line-height:1.3;">${safeHeading}</h1>
          ${paragraphs}
          ${safeAction}
        </td></tr>
        <tr><td style="padding:18px 8px 0;color:#526273;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;">WRITING-XPRESS · Clear steps from brief to delivery</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function emailPaths(orderId: string) {
    const id = encodeURIComponent(orderId);
    return {
        trackOrder: `/track?orderId=${id}`,
        customerOrder: `/user/orders/${id}`,
        writerAssignment: `/writer/order/${id}`,
        adminOrder: `/admin/order/${id}`,
        adminSubmission: `/admin/writer-review/${id}`,
        adminApplications: '/admin/writers',
    };
}
