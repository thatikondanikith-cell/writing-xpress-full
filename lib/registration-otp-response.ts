type RegistrationOtpPayload = {
    success?: unknown;
    registrationId?: unknown;
    message?: unknown;
    error?: unknown;
};

export type RegistrationOtpResponse =
    | { accepted: true; registrationId: string; message: string }
    | { accepted: false; message: string };

const REGISTRATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function interpretRegistrationOtpResponse(status: number, payload: unknown): RegistrationOtpResponse {
    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as RegistrationOtpPayload
        : {};

    if (status === 200 && data.success === true &&
        typeof data.registrationId === 'string' && REGISTRATION_ID_PATTERN.test(data.registrationId)) {
        return {
            accepted: true,
            registrationId: data.registrationId,
            message: typeof data.message === 'string'
                ? data.message
                : 'If the request is eligible, you may receive a verification code.',
        };
    }

    return {
        accepted: false,
        message: typeof data.error === 'string' && data.error.trim()
            ? data.error
            : 'Unable to request a verification code. Please try again.',
    };
}
