import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { resolve } from 'node:path';

const envResult = dotenv.config({
    path: resolve(process.cwd(), '.env.local'),
    override: true,
    quiet: true,
});

let transporter;

function safeFailure(error, fallbackCategory = 'unknown') {
    const value = error && typeof error === 'object' ? error : {};
    const code = typeof value.code === 'string' ? value.code.toUpperCase() : '';
    const responseCode = typeof value.responseCode === 'number' && Number.isInteger(value.responseCode) &&
        value.responseCode >= 100 && value.responseCode <= 599
        ? value.responseCode
        : null;

    let category = fallbackCategory;
    if (code === 'EAUTH' || responseCode === 534 || responseCode === 535) {
        category = 'authentication';
    } else if (/^(ECONNECTION|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EDNS|ENOTFOUND|EHOSTUNREACH|ESOCKET|ETLS)$/.test(code)) {
        category = 'connection';
    } else if (responseCode !== null) {
        category = 'smtp_rejection';
    }

    console.log(`SMTP verification failed: category=${category} statusCode=${responseCode ?? 'null'}`);
}

try {
    if (envResult.error) {
        safeFailure(null, 'configuration');
        process.exitCode = 1;
    } else {
        const host = process.env.SMTP_HOST?.trim();
        const portValue = process.env.SMTP_PORT?.trim();
        const user = process.env.SMTP_USER?.trim();
        const pass = process.env.SMTP_PASS?.trim();
        const port = portValue ? Number(portValue) : NaN;

        if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass) {
            safeFailure(null, 'configuration');
            process.exitCode = 1;
        } else {
            transporter = nodemailer.createTransport({
                host,
                port,
                secure: port === 465,
                auth: { user, pass },
                logger: false,
                debug: false,
                connectionTimeout: 10_000,
                greetingTimeout: 10_000,
                socketTimeout: 15_000,
            });

            await transporter.verify();
            console.log('SMTP connection successful');
            console.log('SMTP authentication successful');
        }
    }
} catch (error) {
    safeFailure(error);
    process.exitCode = 1;
} finally {
    transporter?.close();
}
