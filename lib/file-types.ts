import path from 'node:path';
import { ALLOWED_DOCUMENT_MIME_TYPES } from './document-mime-types';
export { ALLOWED_DOCUMENT_MIME_TYPES } from './document-mime-types';

export const FILE_VALIDATION_VERSION = 1;

export type InvalidDocumentReason =
    | 'filename_invalid'
    | 'extension_unsupported'
    | 'mime_mismatch'
    | 'file_empty'
    | 'pdf_too_short'
    | 'pdf_signature_invalid'
    | 'pdf_password_required'
    | 'pdf_page_count_invalid'
    | 'pdf_document_parse_failed'
    | 'pdf_page_read_failed'
    | 'pdf_text_read_failed'
    | 'pdf_document_cleanup_failed'
    | 'office_file_invalid'
    | 'legacy_office_invalid'
    | 'document_invalid';

export class InvalidDocumentFileError extends Error {
    readonly reason: InvalidDocumentReason;

    constructor(reason: InvalidDocumentReason = 'document_invalid') {
        super('The file is empty, malformed, or does not match its filename and type.');
        this.name = 'InvalidDocumentFileError';
        this.reason = reason;
    }
}

export function sanitizeDocumentFilename(input: string): { filename: string; extension: string } {
    if (typeof input !== 'string' || !input.trim() || input.length > 220 || /[\r\n\0]/.test(input)) {
        throw new InvalidDocumentFileError('filename_invalid');
    }
    const basename = input.trim().replace(/\\/g, '/').split('/').pop() || '';
    const extension = path.extname(basename).toLowerCase();
    if (!ALLOWED_DOCUMENT_MIME_TYPES[extension]) throw new InvalidDocumentFileError('extension_unsupported');

    const stem = basename.slice(0, -extension.length).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    if (!stem || stem.length > 180) throw new InvalidDocumentFileError('filename_invalid');
    return { filename: `${stem}${extension}`, extension };
}

export function getValidatedMimeType(filename: string, validationVersion: unknown, mimeType: unknown): string | null {
    if (validationVersion !== FILE_VALIDATION_VERSION || typeof mimeType !== 'string') return null;
    try {
        const { extension } = sanitizeDocumentFilename(filename);
        const expected = ALLOWED_DOCUMENT_MIME_TYPES[extension];
        return mimeType === expected ? expected : null;
    } catch {
        return null;
    }
}

export function createSafeContentDisposition(filename: string, mode: 'inline' | 'attachment'): string {
    let safeName: string;
    try {
        const base = path.basename(filename.replace(/\\/g, '/'));
        safeName = base.replace(/[\r\n\0]/g, '_').slice(0, 180) || 'download';
    } catch {
        safeName = 'download';
    }
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
    const encodedName = encodeURIComponent(safeName).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `${mode}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}
