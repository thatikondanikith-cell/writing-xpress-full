export const ALLOWED_DOCUMENT_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});

/** Client-side preflight only; the server still validates file contents. */
export function hasMatchingDocumentFileType(filename: string, declaredMimeType: string): boolean {
    if (typeof filename !== 'string' || typeof declaredMimeType !== 'string') return false;
    const extensionIndex = filename.lastIndexOf('.');
    if (extensionIndex <= 0) return false;
    const extension = filename.slice(extensionIndex).toLowerCase();
    const expectedMimeType = ALLOWED_DOCUMENT_MIME_TYPES[extension];
    return Boolean(expectedMimeType) && declaredMimeType.trim().toLowerCase() === expectedMimeType;
}
