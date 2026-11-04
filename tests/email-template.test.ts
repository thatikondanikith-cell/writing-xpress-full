import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApplicationUrl, emailPaths, renderBrandedEmailHtml } from '@/lib/email-template';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('transactional email template and action links', () => {
    it('renders a responsive branded HTML email and escapes dynamic content', () => {
        const html = renderBrandedEmailHtml(
            'Order <received>',
            'Hello <customer>\n\nYour order & details are ready.',
            { label: 'View <order>', url: 'https://writing-xpress.example/user/orders/WX-1' },
        );

        expect(html).toContain('<table role="presentation"');
        expect(html).toContain('WRITING-XPRESS');
        expect(html).toContain('background-color:#F5F1E8');
        expect(html).toContain('background-color:#FFFFFF');
        expect(html).toContain('background-color:#E64B45');
        expect(html).toContain('Order &lt;received&gt;');
        expect(html).toContain('Hello &lt;customer&gt;');
        expect(html).toContain('Your order &amp; details are ready.');
        expect(html).toContain('View &lt;order&gt;');
        expect(html).not.toContain('<customer>');
    });

    it('builds action links only from a configured public HTTPS origin', () => {
        vi.stubEnv('APP_BASE_URL', 'https://writing-xpress.example');
        vi.stubEnv('NODE_ENV', 'production');
        expect(buildApplicationUrl('/user/orders/WX-20261102-0001')).toBe('https://writing-xpress.example/user/orders/WX-20261102-0001');
        expect(buildApplicationUrl('/track?orderId=WX-20261102-0001')).toBe('https://writing-xpress.example/track?orderId=WX-20261102-0001');
        expect(buildApplicationUrl('//evil.example/path')).toBeNull();

        vi.stubEnv('APP_BASE_URL', 'http://writing-xpress.example');
        expect(buildApplicationUrl('/track')).toBeNull();
        vi.stubEnv('APP_BASE_URL', 'http://localhost:3000');
        expect(buildApplicationUrl('/track')).toBeNull();
    });

    it('allows local HTTP action links outside production and renders them as buttons', () => {
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubEnv('APP_BASE_URL', 'http://localhost:3000');
        const orderId = 'WX-20261103-0042';
        const url = buildApplicationUrl(emailPaths(orderId).trackOrder);
        expect(url).toBe(`http://localhost:3000/track?orderId=${orderId}`);
        const html = renderBrandedEmailHtml('Order received', 'Your order was received.', { label: 'Track Your Order', url: url! });
        expect(html).toContain(`<a href="${url}"`);
        expect(html).toContain('>Track Your Order</a>');

        vi.stubEnv('NODE_ENV', 'production');
        expect(buildApplicationUrl(emailPaths(orderId).trackOrder)).toBeNull();
    });

    it('omits links when the application URL is not configured', () => {
        delete process.env.APP_BASE_URL;
        expect(buildApplicationUrl('/writer/dashboard')).toBeNull();
    });

    it('maps notification links to existing application routes', () => {
        const links = emailPaths('WX-20261102-0001');
        const routeFiles: Array<[string, string]> = [
            [links.trackOrder, 'app/track/page.tsx'],
            [links.customerOrder, 'app/user/orders/[id]/page.tsx'],
            [links.writerAssignment, 'app/writer/order/[id]/page.tsx'],
            [links.adminOrder, 'app/admin/order/[id]/page.tsx'],
            [links.adminSubmission, 'app/admin/writer-review/[id]/page.tsx'],
            [links.adminApplications, 'app/admin/writers/page.tsx'],
            ['/writer/dashboard', 'app/writer/dashboard/page.tsx'],
            ['/writer/signup', 'app/writer/signup/page.tsx'],
        ];

        for (const [, routeFile] of routeFiles) {
            expect(existsSync(resolve(projectRoot, routeFile)), `${routeFile} should exist`).toBe(true);
        }
        expect(links.trackOrder).toContain('orderId=WX-20261102-0001');
    });
});
