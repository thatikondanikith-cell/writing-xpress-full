import * as jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import type { NextRequest, NextResponse } from 'next/server';

export const SESSION_COOKIE_NAME = 'session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type SessionClaims =
    | { sub: string; role: 'user'; email: string; writerAccess?: true }
    | { sub: string; role: 'writer'; email: string }
    | { sub: string; role: 'admin' };

export type DeliveryDownloadClaims = {
    sub: string;
    role: 'user';
    email: string;
    purpose: 'delivery-download';
    orderId: string;
    fileId: string;
};

function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret || !secret.trim()) {
        throw new Error('JWT_SECRET environment variable is required for authentication.');
    }
    return secret;
}

export function createToken(payload: object) {
    return jwt.sign(payload, getJwtSecret(), {
        expiresIn: '7d',
    });
}

export function verifyToken(token: string) {
    const secret = getJwtSecret();
    try {
        return jwt.verify(token, secret);
    } catch {
        return null;
    }
}

export function createDeliveryDownloadToken(
    session: Extract<SessionClaims, { role: 'user' }>,
    orderId: string,
    fileId: string
): string {
    return jwt.sign({
        sub: session.sub,
        role: 'user',
        email: session.email,
        purpose: 'delivery-download',
        orderId,
        fileId,
    }, getJwtSecret(), { expiresIn: '5m' });
}

export function verifyDeliveryDownloadToken(token: string): DeliveryDownloadClaims | null {
    const payload = verifyToken(token);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

    const claims = payload as jwt.JwtPayload & Record<string, unknown>;
    if (
        typeof claims.sub !== 'string' || !claims.sub.trim() ||
        claims.role !== 'user' ||
        typeof claims.email !== 'string' || !claims.email.trim() ||
        claims.purpose !== 'delivery-download' ||
        typeof claims.orderId !== 'string' || !claims.orderId.trim() ||
        typeof claims.fileId !== 'string' || !claims.fileId.trim() ||
        typeof claims.exp !== 'number'
    ) return null;

    return {
        sub: claims.sub,
        role: 'user',
        email: claims.email,
        purpose: 'delivery-download',
        orderId: claims.orderId,
        fileId: claims.fileId,
    };
}

export function getSession(request: Pick<NextRequest, 'cookies'>): SessionClaims | null {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;

    const payload = verifyToken(token);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

    const { sub, role, email } = payload as jwt.JwtPayload;
    if (typeof sub !== 'string' || !sub.trim()) return null;

    if (role === 'user') {
        if (typeof email !== 'string' || !email.trim()) return null;
        return claimsWriterAccess(payload)
            ? { sub, role, email, writerAccess: true }
            : { sub, role, email };
    }

    if (role === 'writer') {
        if (typeof email !== 'string' || !email.trim()) return null;
        return { sub, role, email };
    }

    if (role === 'admin') {
        return { sub, role };
    }

    return null;
}

function claimsWriterAccess(payload: jwt.JwtPayload | string): boolean {
    return typeof payload === 'object' && payload !== null && payload.writerAccess === true;
}

export function hasWriterSession(session: SessionClaims): session is Exclude<SessionClaims, { role: 'admin' }> {
    return session.role === 'writer' || (session.role === 'user' && session.writerAccess === true);
}

export function setSessionCookie(response: NextResponse, token: string): void {
    response.cookies.set(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_SECONDS,
    });
}

export function clearSessionCookies(response: NextResponse): void {
    const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: '/',
        maxAge: 0,
        expires: new Date(0),
    };

    response.cookies.set(SESSION_COOKIE_NAME, '', cookieOptions);
    // Clear cookies from the pre-session implementation as well.
    response.cookies.set('userAuth', '', cookieOptions);
    response.cookies.set('adminAuth', '', cookieOptions);
}

export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (!/^\$2b\$12\$[./A-Za-z0-9]{53}$/.test(storedHash)) return false;
    return bcrypt.compare(password, storedHash);
}
