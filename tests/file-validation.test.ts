import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as CFB from 'cfb';
import {
    InvalidDocumentFileError,
    sanitizeDocumentFilename,
    validateDocumentFile,
} from '@/lib/file-validation';
import { createSafeContentDisposition, getValidatedMimeType } from '@/lib/file-types';
import { hasMatchingDocumentFileType } from '@/lib/document-mime-types';
import nextConfig from '../next.config';

function makePdf(): Buffer {
    const header = Buffer.from('%PDF-1.4\n% test\n', 'ascii');
    const content = Buffer.from('BT /F1 12 Tf 72 720 Td (Writing Xpress sample text) Tj ET', 'ascii');
    const objects = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
        `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content.toString('ascii')}\nendstream\nendobj\n`,
        '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    ];
    const chunks = [header];
    const offsets = [0];
    let offset = header.length;
    for (const object of objects) {
        offsets.push(offset);
        const bytes = Buffer.from(object, 'ascii');
        chunks.push(bytes);
        offset += bytes.length;
    }
    const xrefOffset = offset;
    let xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (const value of offsets.slice(1)) xref += `${String(value).padStart(10, '0')} 00000 n \n`;
    const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(Buffer.from(`${xref}${trailer}`, 'ascii'));
    return Buffer.concat(chunks);
}

function assemblePdf(objectBodies: Buffer[], trailerExtras = ''): Buffer {
    const header = Buffer.from('%PDF-1.4\n% test\n', 'ascii');
    const chunks: Buffer[] = [header];
    const offsets = [0];
    let offset = header.length;
    objectBodies.forEach((body, index) => {
        offsets.push(offset);
        const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'ascii'), body, Buffer.from('\nendobj\n', 'ascii')]);
        chunks.push(object);
        offset += object.length;
    });
    const xrefOffset = offset;
    let xref = `xref\n0 ${objectBodies.length + 1}\n0000000000 65535 f \n`;
    for (const objectOffset of offsets.slice(1)) xref += `${String(objectOffset).padStart(10, '0')} 00000 n \n`;
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objectBodies.length + 1} /Root 1 0 R ${trailerExtras} >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'ascii'));
    return Buffer.concat(chunks);
}

function makeScannedPdf(pageCount = 1): Buffer {
    const imageBytes = Buffer.from([0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]);
    const content = Buffer.from('q\n144 0 0 144 0 0 cm\n/Scan Do\nQ\n', 'ascii');
    const contentId = pageCount + 3;
    const imageId = pageCount + 4;
    const pageIds = Array.from({ length: pageCount }, (_, index) => index + 3);
    const pageRefs = pageIds.map((id) => `${id} 0 R`).join(' ');
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
        Buffer.from(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pageCount} >>`, 'ascii'),
        ...pageIds.map(() => Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 144 144] /Resources << /XObject << /Scan ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`, 'ascii')),
        Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'ascii'), content, Buffer.from('endstream', 'ascii')]),
        Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imageBytes.length} >>\nstream\n`, 'ascii'), imageBytes, Buffer.from('\nendstream', 'ascii')]),
    ];
    return assemblePdf(objects);
}

const PASSWORD_PADDING = Buffer.from([
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
    0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPdfPassword(value: string): Buffer {
    const bytes = Buffer.from(value, 'latin1');
    return Buffer.concat([bytes.subarray(0, 32), PASSWORD_PADDING]).subarray(0, 32);
}

function rc4(key: Buffer, input: Buffer): Buffer {
    const state = Uint8Array.from({ length: 256 }, (_, index) => index);
    let j = 0;
    for (let i = 0; i < 256; i += 1) {
        j = (j + state[i] + key[i % key.length]) & 0xff;
        [state[i], state[j]] = [state[j], state[i]];
    }
    const output = Buffer.alloc(input.length);
    let i = 0;
    j = 0;
    for (let index = 0; index < input.length; index += 1) {
        i = (i + 1) & 0xff;
        j = (j + state[i]) & 0xff;
        [state[i], state[j]] = [state[j], state[i]];
        output[index] = input[index] ^ state[(state[i] + state[j]) & 0xff];
    }
    return output;
}

function md5(input: Buffer): Buffer {
    return createHash('md5').update(input).digest();
}

function makePasswordProtectedPdf(): Buffer {
    const fileId = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const ownerKey = md5(padPdfPassword('owner-password')).subarray(0, 5);
    const ownerEntry = rc4(ownerKey, padPdfPassword('reader-password'));
    const permissionBytes = Buffer.from([0xfc, 0xff, 0xff, 0xff]);
    const fileKey = md5(Buffer.concat([padPdfPassword('reader-password'), ownerEntry, permissionBytes, fileId])).subarray(0, 5);
    const userEntry = rc4(fileKey, PASSWORD_PADDING);
    const encryptionDictionary = Buffer.from(
        `<< /Filter /Standard /V 1 /R 2 /O <${ownerEntry.toString('hex')}> /U <${userEntry.toString('hex')}> /P -4 >>`,
        'ascii',
    );
    return assemblePdf([
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
        Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
        Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', 'ascii'),
        Buffer.from('<< /Length 0 >>\nstream\n\nendstream', 'ascii'),
        encryptionDictionary,
    ], `/Encrypt 5 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]`);
}

function crc32(input: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of input) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: Array<[string, string]>): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let localOffset = 0;
    let centralSize = 0;
    for (const [name, value] of entries) {
        const nameBytes = Buffer.from(name, 'utf8');
        const data = Buffer.from(value, 'utf8');
        const checksum = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        localParts.push(local, nameBytes, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(localOffset, 42);
        centralParts.push(central, nameBytes);
        const localLength = local.length + nameBytes.length + data.length;
        localOffset += localLength;
        centralSize += central.length + nameBytes.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(localOffset, 16);
    return Buffer.concat([...localParts, ...centralParts, end]);
}

const officeTypesPrefix = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
const officeRelsPrefix = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const officeRelType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const wordMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const pptMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function makeDocxEntries(): Array<[string, string]> {
    return [
        ['[Content_Types].xml', `${officeTypesPrefix}<Override PartName="/word/document.xml" ContentType="${wordMime}.main+xml"/></Types>`],
        ['_rels/.rels', `${officeRelsPrefix}<Relationship Id="rId1" Type="${officeRelType}" Target="word/document.xml"/></Relationships>`],
        ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'],
    ];
}

function makePptxEntries(): Array<[string, string]> {
    return [
        ['[Content_Types].xml', `${officeTypesPrefix}<Override PartName="/ppt/presentation.xml" ContentType="${pptMime}.main+xml"/></Types>`],
        ['_rels/.rels', `${officeRelsPrefix}<Relationship Id="rId1" Type="${officeRelType}" Target="ppt/presentation.xml"/></Relationships>`],
        ['ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="rId2"/></p:sldIdLst></p:presentation>'],
    ];
}

function makeOleFile(streamName: string): Buffer {
    const container = CFB.utils.cfb_new();
    CFB.utils.cfb_add(container, `Root Entry/${streamName}`, Buffer.from('valid stream content'));
    return Buffer.from(CFB.write(container, { type: 'buffer' }) as Uint8Array);
}

async function validate(filename: string, mimeType: string, bytes: Buffer) {
    return validateDocumentFile({ filename, declaredMimeType: mimeType, bytes });
}

describe('shared document file validation', () => {
    it('matches client-side filename extensions and case-normalized MIME types', () => {
        expect(hasMatchingDocumentFileType('paper.pdf', 'application/pdf')).toBe(true);
        expect(hasMatchingDocumentFileType('paper.PDF', ' Application/PDF ')).toBe(true);
        expect(hasMatchingDocumentFileType('paper.docx', wordMime)).toBe(true);
        expect(hasMatchingDocumentFileType('paper.ppt', 'application/vnd.ms-powerpoint')).toBe(true);
        expect(hasMatchingDocumentFileType('paper.pdf', 'application/msword')).toBe(false);
        expect(hasMatchingDocumentFileType('paper.exe', 'application/pdf')).toBe(false);
        expect(hasMatchingDocumentFileType('.pdf', 'application/pdf')).toBe(false);
        expect(hasMatchingDocumentFileType('paper.pdf', '')).toBe(false);
    });

    it('accepts a text-based PDF and sanitizes its filename', async () => {
        const file = await validate('../final report.PDF', 'Application/PDF', makePdf());
        expect(file.filename).toBe('final_report.pdf');
        expect(file.mimeType).toBe('application/pdf');
        expect(file.validationVersion).toBe(1);
    });

    it('accepts a multi-page scanned PDF with image-only page content', async () => {
        const file = await validate('mobile-scan.pdf', 'application/pdf', makeScannedPdf(3));
        expect(file.filename).toBe('mobile-scan.pdf');
        expect(file.mimeType).toBe('application/pdf');
    });

    it('keeps PDF.js external so its package-relative worker resolves in the Next server runtime', () => {
        expect(nextConfig.serverExternalPackages).toContain('pdfjs-dist');
    });

    it('rejects scanned PDFs exceeding the 2,000-page limit', async () => {
        await expect(validate('oversized-scan.pdf', 'application/pdf', makeScannedPdf(2_001)))
            .rejects.toMatchObject({ reason: 'pdf_page_count_invalid' });
    });

    it('rejects an empty PDF, malformed PDF and password-protected PDF with distinct reasons', async () => {
        await expect(validate('empty.pdf', 'application/pdf', Buffer.alloc(0)))
            .rejects.toMatchObject({ reason: 'file_empty' });
        await expect(validate('malformed.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n' + 'x'.repeat(80) + '\n%%EOF', 'ascii')))
            .rejects.toMatchObject({ reason: 'pdf_document_parse_failed' });
        await expect(validate('encrypted.pdf', 'application/pdf', makePasswordProtectedPdf()))
            .rejects.toMatchObject({ reason: 'pdf_password_required' });
    });

    it('rejects malformed PDFs with the stable parser failure reason', async () => {
        await expect(validate('paper.pdf', 'application/pdf', Buffer.alloc(40, 0x61)))
            .rejects.toMatchObject({ reason: 'pdf_signature_invalid' });
        const unreadablePdf = Buffer.from(`%PDF-1.7\n${'x'.repeat(80)}\n%%EOF`, 'ascii');
        await expect(validate('paper.pdf', 'application/pdf', unreadablePdf))
            .rejects.toMatchObject({ reason: 'pdf_document_parse_failed' });
    });

    it('accepts DOCX and PPTX only when their ZIP packages include required Office XML structures', async () => {
        const docx = await validate('paper.docx', wordMime, makeZip(makeDocxEntries()));
        const pptx = await validate('slides.pptx', pptMime, makeZip(makePptxEntries()));
        expect(docx.extension).toBe('.docx');
        expect(pptx.extension).toBe('.pptx');
    });

    it('accepts readable legacy OLE files with the expected DOC or PPT stream', async () => {
        const doc = await validate('paper.doc', 'application/msword', makeOleFile('WordDocument'));
        const ppt = await validate('slides.ppt', 'application/vnd.ms-powerpoint', makeOleFile('PowerPoint Document'));
        expect(doc.extension).toBe('.doc');
        expect(ppt.extension).toBe('.ppt');
    });

    it.each([
        ['paper.pdf', 'application/msword', makePdf()],
        ['paper.docx', wordMime, Buffer.from('not a ZIP archive')],
        ['paper.pptx', pptMime, makeZip(makeDocxEntries())],
        ['paper.doc', 'application/msword', makeOleFile('PowerPoint Document')],
        ['paper.ppt', 'application/vnd.ms-powerpoint', makeOleFile('WordDocument')],
        ['paper.exe', 'application/pdf', makePdf()],
        ['paper.pdf', 'application/pdf', Buffer.alloc(0)],
        ['paper.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')],
    ])('rejects invalid or mismatched input %s', async (filename, mimeType, bytes) => {
        await expect(validate(filename, mimeType, bytes)).rejects.toBeInstanceOf(InvalidDocumentFileError);
    });

    it('rejects arbitrary ZIPs and Office packages with missing required parts', async () => {
        const arbitraryZip = makeZip([['readme.txt', 'just a zip']]);
        const incompleteDocx = makeZip([
            ['[Content_Types].xml', `${officeTypesPrefix}</Types>`],
            ['_rels/.rels', `${officeRelsPrefix}</Relationships>`],
        ]);
        await expect(validate('readme.docx', wordMime, arbitraryZip)).rejects.toBeInstanceOf(InvalidDocumentFileError);
        await expect(validate('broken.docx', wordMime, incompleteDocx)).rejects.toBeInstanceOf(InvalidDocumentFileError);
    });

    it('rejects malformed OLE containers', async () => {
        await expect(validate('bad.doc', 'application/msword', Buffer.alloc(512, 0))).rejects.toBeInstanceOf(InvalidDocumentFileError);
    });

    it('does not accept unsupported or hidden-only file extensions', () => {
        expect(() => sanitizeDocumentFilename('file.html')).toThrow(InvalidDocumentFileError);
        expect(() => sanitizeDocumentFilename('.pdf')).toThrow(InvalidDocumentFileError);
    });

    it('marks validated PDFs inline, Office formats as attachments, and legacy metadata as untrusted', () => {
        expect(getValidatedMimeType('paper.pdf', 1, 'application/pdf')).toBe('application/pdf');
        expect(createSafeContentDisposition('paper.pdf', 'inline')).toMatch(/^inline;/);
        expect(getValidatedMimeType('paper.docx', 1, wordMime)).toBe(wordMime);
        expect(createSafeContentDisposition('paper.docx', 'attachment')).toMatch(/^attachment;/);
        expect(getValidatedMimeType('old.docx', undefined, wordMime)).toBeNull();
        expect(getValidatedMimeType('spoof.pdf', 1, wordMime)).toBeNull();
    });
});
