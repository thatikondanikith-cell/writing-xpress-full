import { DOMParser, onErrorStopParsing } from '@xmldom/xmldom';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as CFB from 'cfb';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as yauzl from 'yauzl';
import {
    ALLOWED_DOCUMENT_MIME_TYPES,
    FILE_VALIDATION_VERSION,
    InvalidDocumentFileError,
    sanitizeDocumentFilename,
} from './file-types';
export { ALLOWED_DOCUMENT_MIME_TYPES, FILE_VALIDATION_VERSION, InvalidDocumentFileError, sanitizeDocumentFilename } from './file-types';

const PDF_MAX_PAGES = 2_000;
const ZIP_MAX_ENTRIES = 10_000;
const ZIP_MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const ZIP_MAX_REQUIRED_XML_BYTES = 8 * 1024 * 1024;
const pdfWarningSuppressionKey = Symbol.for('writing-xpress.pdfjs-warning-suppression');
type PdfWarningSuppressionState = { context: AsyncLocalStorage<boolean> };
const pdfWarningSuppressionGlobal = globalThis as unknown as Record<PropertyKey, unknown>;
const existingPdfWarningSuppression = pdfWarningSuppressionGlobal[pdfWarningSuppressionKey] as PdfWarningSuppressionState | undefined;
const pdfWarningSuppression = existingPdfWarningSuppression?.context ?? new AsyncLocalStorage<boolean>();

function suppressPdfWarningMessagesDuringValidation(): void {
    if (process.env.NODE_ENV !== 'development') return;
    if (existingPdfWarningSuppression) return;

    const originalWarn = console.warn.bind(console);
    pdfWarningSuppressionGlobal[pdfWarningSuppressionKey] = { context: pdfWarningSuppression } satisfies PdfWarningSuppressionState;
    console.warn = (...args: unknown[]) => {
        const first = args[0];
        if (pdfWarningSuppression.getStore() && typeof first === 'string' && first.startsWith('Warning:')) return;
        originalWarn(...args);
    };
}

suppressPdfWarningMessagesDuringValidation();

function isPdfPasswordError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'PasswordException';
}
type XmlDocument = ReturnType<InstanceType<typeof DOMParser>['parseFromString']>;
type XmlElement = NonNullable<XmlDocument['documentElement']>;

function getXmlRoot(doc: XmlDocument): XmlElement {
    const root = doc.documentElement;
    if (!root) throw new InvalidDocumentFileError();
    return root;
}

export class UploadBodyTooLargeError extends Error {
    readonly reason: 'declared_size_exceeded' | 'streamed_size_exceeded';

    constructor(reason: 'declared_size_exceeded' | 'streamed_size_exceeded' = 'streamed_size_exceeded') {
        super('The multipart request exceeds its size limit.');
        this.name = 'UploadBodyTooLargeError';
        this.reason = reason;
    }
}

export type InvalidMultipartReason =
    | 'content_length_invalid'
    | 'content_type_invalid'
    | 'body_missing'
    | 'body_read_failed'
    | 'form_data_parse_failed';

export class InvalidMultipartBodyError extends Error {
    readonly reason: InvalidMultipartReason;

    constructor(reason: InvalidMultipartReason = 'form_data_parse_failed') {
        super('The multipart request is invalid.');
        this.name = 'InvalidMultipartBodyError';
        this.reason = reason;
    }
}

export type ValidatedDocumentFile = {
    filename: string;
    extension: string;
    mimeType: string;
    bytes: Buffer;
    validationVersion: typeof FILE_VALIDATION_VERSION;
};

function requireXml(xml: Buffer | undefined, expectedRoot: string): XmlDocument {
    if (!xml || xml.length === 0 || xml.length > ZIP_MAX_REQUIRED_XML_BYTES) throw new InvalidDocumentFileError();
    const source = xml.toString('utf8');
    if (/<!DOCTYPE/i.test(source)) throw new InvalidDocumentFileError();
    let doc: XmlDocument;
    try {
        doc = new DOMParser({ onError: onErrorStopParsing }).parseFromString(source, 'application/xml');
    } catch {
        throw new InvalidDocumentFileError();
    }
    if (getXmlRoot(doc).localName !== expectedRoot || getXmlRoot(doc).namespaceURI == null) {
        throw new InvalidDocumentFileError();
    }
    return doc;
}

function findElementByName(root: XmlElement, localName: string): XmlElement | null {
    const elements = root.getElementsByTagNameNS('*', localName);
    return elements.length ? elements.item(0) : null;
}

function hasOfficeDocumentRelationship(doc: XmlDocument, expectedTarget: string): boolean {
    const root = getXmlRoot(doc);
    if (root.namespaceURI !== 'http://schemas.openxmlformats.org/package/2006/relationships') return false;
    const relationships = root.getElementsByTagNameNS(root.namespaceURI, 'Relationship');
    for (let index = 0; index < relationships.length; index += 1) {
        const relationship = relationships.item(index);
        if (!relationship) continue;
        if (relationship.getAttribute('Type') !== 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument') continue;
        if (relationship.getAttribute('TargetMode') === 'External') return false;
        const rawTarget = relationship.getAttribute('Target');
        if (!rawTarget) return false;
        const target = rawTarget.replace(/^\//, '');
        return target === expectedTarget;
    }
    return false;
}

function validateOfficeXmlParts(extension: '.docx' | '.pptx', parts: Map<string, Buffer>) {
    const types = requireXml(parts.get('[Content_Types].xml'), 'Types');
    const rels = requireXml(parts.get('_rels/.rels'), 'Relationships');
    const expected = extension === '.docx'
        ? {
            part: '/word/document.xml',
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
            target: 'word/document.xml',
            root: 'document',
            namespace: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            child: 'body',
        }
        : {
            part: '/ppt/presentation.xml',
            contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
            target: 'ppt/presentation.xml',
            root: 'presentation',
            namespace: 'http://schemas.openxmlformats.org/presentationml/2006/main',
            child: 'sldIdLst',
        };

    const overrides = getXmlRoot(types).getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/package/2006/content-types', 'Override'
    );
    let hasExpectedContentType = false;
    for (let index = 0; index < overrides.length; index += 1) {
        const item = overrides.item(index);
        if (item?.getAttribute('PartName') === expected.part && item.getAttribute('ContentType') === expected.contentType) {
            hasExpectedContentType = true;
        }
    }
    if (!hasExpectedContentType || !hasOfficeDocumentRelationship(rels, expected.target)) {
        throw new InvalidDocumentFileError();
    }

    const mainPart = requireXml(parts.get(expected.target), expected.root);
    const mainRoot = getXmlRoot(mainPart);
    if (mainRoot.namespaceURI !== expected.namespace ||
        !findElementByName(mainRoot, expected.child)) {
        throw new InvalidDocumentFileError();
    }
    if (extension === '.pptx') {
        const slideList = findElementByName(mainRoot, 'sldIdLst');
        if (!slideList || slideList.getElementsByTagNameNS(expected.namespace, 'sldId').length === 0) {
            throw new InvalidDocumentFileError();
        }
    }
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[index] = value >>> 0;
    }
    return table;
})();

function updateCrc32(crc: number, chunk: Buffer): number {
    let value = crc;
    for (const byte of chunk) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return value >>> 0;
}

async function validateOfficeZip(bytes: Buffer, extension: '.docx' | '.pptx') {
    let archive: yauzl.ZipFile;
    try {
        archive = await yauzl.fromBufferPromise(bytes, {
            lazyEntries: true,
            validateEntrySizes: true,
            strictFileNames: true,
        });
    } catch {
        throw new InvalidDocumentFileError();
    }
    const entries = new Set<string>();
    const requiredParts = new Map<string, Buffer>();
    let entryCount = 0;
    let totalUncompressedBytes = 0;

    try {
        for await (const entry of archive.eachEntry()) {
            entryCount += 1;
            if (entryCount > ZIP_MAX_ENTRIES || entry.isEncrypted() || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
                throw new InvalidDocumentFileError();
            }
            const name = entry.fileName;
            if (!name || name.startsWith('/') || name.split('/').some((part) => part === '..') || entries.has(name)) {
                throw new InvalidDocumentFileError();
            }
            entries.add(name);
            totalUncompressedBytes += entry.uncompressedSize;
            if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > ZIP_MAX_UNCOMPRESSED_BYTES) {
                throw new InvalidDocumentFileError();
            }

            const capture = name === '[Content_Types].xml' || name === '_rels/.rels' ||
                name === 'word/document.xml' || name === 'ppt/presentation.xml';
            if (capture && entry.uncompressedSize > ZIP_MAX_REQUIRED_XML_BYTES) throw new InvalidDocumentFileError();

            if (!name.endsWith('/')) {
                const stream = await archive.openReadStreamPromise(entry);
                const chunks: Buffer[] = [];
                let actualSize = 0;
                let crc = 0xffffffff;
                for await (const chunk of stream) {
                    const buffer = Buffer.from(chunk as Buffer);
                    actualSize += buffer.byteLength;
                    if (actualSize > entry.uncompressedSize || actualSize > ZIP_MAX_UNCOMPRESSED_BYTES) {
                        stream.destroy();
                        throw new InvalidDocumentFileError();
                    }
                    crc = updateCrc32(crc, buffer);
                    if (capture) chunks.push(buffer);
                }
                if (actualSize !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) {
                    throw new InvalidDocumentFileError();
                }
                if (capture) requiredParts.set(name, Buffer.concat(chunks, actualSize));
            }
        }
    } catch (error) {
        if (error instanceof InvalidDocumentFileError) throw error;
        throw new InvalidDocumentFileError();
    } finally {
        archive.close();
    }

    validateOfficeXmlParts(extension, requiredParts);
}

function validateLegacyOle(bytes: Buffer, extension: '.doc' | '.ppt') {
    if (bytes.length < 512) throw new InvalidDocumentFileError();
    let container: CFB.CFB$Container;
    try {
        container = CFB.read(bytes, { type: 'buffer', WTF: true });
    } catch {
        throw new InvalidDocumentFileError();
    }
    const streamName = extension === '.doc' ? 'WordDocument' : 'PowerPoint Document';
    const stream = CFB.find(container, streamName);
    const streamBytes = stream?.content;
    if (!stream || stream.type !== 2 ||
        !streamBytes || streamBytes.length === 0) {
        throw new InvalidDocumentFileError();
    }
    // This confirms a readable OLE container with the expected format stream;
    // it does not fully validate the legacy Office document's internal semantics.
}

async function validatePdf(bytes: Buffer) {
    if (bytes.length < 32) throw new InvalidDocumentFileError('pdf_too_short');
    const header = bytes.subarray(0, Math.min(bytes.length, 1024)).toString('latin1');
    const footer = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
    if (!header.includes('%PDF-') || !footer.includes('%%EOF')) throw new InvalidDocumentFileError('pdf_signature_invalid');

    let loadingTask: ReturnType<typeof getDocument> | undefined;
    let validationStage: 'document_initialization' | 'document_loading' | 'page_count_validation' | 'page_loading' | 'page_contents' | 'page_cleanup' = 'document_initialization';
    let validationFailure: InvalidDocumentFileError | undefined;

    try {
        await pdfWarningSuppression.run(true, async () => {
            validationStage = 'document_initialization';
            loadingTask = getDocument({
                data: new Uint8Array(bytes),
                isEvalSupported: false,
                useWasm: false,
            });

            validationStage = 'document_loading';
            const pdf = await loadingTask.promise;

            validationStage = 'page_count_validation';
            if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > PDF_MAX_PAGES) {
                throw new InvalidDocumentFileError('pdf_page_count_invalid');
            }

            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
                validationStage = 'page_loading';
                const page = await pdf.getPage(pageNumber);
                validationStage = 'page_contents';
                await page.getTextContent();
                validationStage = 'page_cleanup';
                page.cleanup();
            }
        });
    } catch (error) {
        if (error instanceof InvalidDocumentFileError) {
            validationFailure = error;
        } else {
            const reason = isPdfPasswordError(error)
                ? 'pdf_password_required'
                : validationStage === 'document_initialization' || validationStage === 'document_loading'
                    ? 'pdf_document_parse_failed'
                    : validationStage === 'page_loading' ? 'pdf_page_read_failed'
                        : validationStage === 'page_contents' || validationStage === 'page_cleanup' ? 'pdf_text_read_failed'
                            : 'pdf_document_parse_failed';
            validationFailure = new InvalidDocumentFileError(reason);
        }
    }

    if (loadingTask) {
        try {
            await pdfWarningSuppression.run(true, () => loadingTask!.destroy());
        } catch {
            if (!validationFailure) {
                validationFailure = new InvalidDocumentFileError('pdf_document_cleanup_failed');
            }
        }
    }

    if (validationFailure) throw validationFailure;
}

export async function validateDocumentFile(input: {
    filename: string;
    declaredMimeType: string;
    bytes: Uint8Array | Buffer;
}): Promise<ValidatedDocumentFile> {
    const { filename, extension } = sanitizeDocumentFilename(input.filename);
    const mimeType = ALLOWED_DOCUMENT_MIME_TYPES[extension];
    if (typeof input.declaredMimeType !== 'string' || input.declaredMimeType.trim().toLowerCase() !== mimeType) {
        throw new InvalidDocumentFileError('mime_mismatch');
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.length === 0) throw new InvalidDocumentFileError('file_empty');

    if (extension === '.pdf') await validatePdf(bytes);
    else if (extension === '.docx' || extension === '.pptx') await validateOfficeZip(bytes, extension);
    else validateLegacyOle(bytes, extension as '.doc' | '.ppt');

    return { filename, extension, mimeType, bytes, validationVersion: FILE_VALIDATION_VERSION };
}

async function cancelRequestBody(request: Request): Promise<void> {
    try {
        await request.body?.cancel();
    } catch {
        // Preserve the explicit size error even if the runtime cannot cancel.
    }
}

export async function parseMultipartFormDataWithinLimit(request: Request, maximumBytes: number): Promise<FormData> {
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
        if (!/^\d+$/.test(contentLength)) throw new InvalidMultipartBodyError('content_length_invalid');
        const declared = Number(contentLength);
        if (!Number.isSafeInteger(declared)) throw new InvalidMultipartBodyError('content_length_invalid');
        if (declared > maximumBytes) {
            await cancelRequestBody(request);
            throw new UploadBodyTooLargeError('declared_size_exceeded');
        }
    }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
        throw new InvalidMultipartBodyError('content_type_invalid');
    }
    if (!request.body) throw new InvalidMultipartBodyError('body_missing');

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maximumBytes) {
                try { await reader.cancel(); } catch { /* Keep returning 413. */ }
                throw new UploadBodyTooLargeError('streamed_size_exceeded');
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof UploadBodyTooLargeError) throw error;
        throw new InvalidMultipartBodyError('body_read_failed');
    } finally {
        reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    try {
        const requestBody = new ArrayBuffer(body.byteLength);
        new Uint8Array(requestBody).set(body);
        return await new Request(request.url, { method: 'POST', headers, body: requestBody }).formData();
    } catch {
        throw new InvalidMultipartBodyError('form_data_parse_failed');
    }
}

