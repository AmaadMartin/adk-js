/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AdmZip from 'adm-zip';
import {describe, expect, it} from 'vitest';
import {
  extractDocxText,
  MAX_XML_BYTES,
} from '../../src/utils/document_text_utils.js';

const WORDPROCESSINGML_NAMESPACE =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Builds a DOCX buffer whose body is `documentXml`. */
function buildDocx(documentXml: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  return zip.toBuffer();
}

/** Wraps `body` in a WordprocessingML document declaring `prefix`. */
function wordDocument(body: string, prefix = 'w'): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${prefix}:document xmlns:${prefix}="${WORDPROCESSINGML_NAMESPACE}">` +
    `<${prefix}:body>${body}</${prefix}:body></${prefix}:document>`
  );
}

describe('extractDocxText', () => {
  it('extracts the text of a minimal document', () => {
    const docx = buildDocx(wordDocument('<w:p><w:t>Hello DOCX</w:t></w:p>'));

    expect(extractDocxText(docx)).toEqual('Hello DOCX');
  });

  it('honours a custom namespace prefix', () => {
    const docx = buildDocx(
      wordDocument('<ns0:p><ns0:t>Custom prefix</ns0:t></ns0:p>', 'ns0'),
    );

    expect(extractDocxText(docx)).toEqual('Custom prefix');
  });

  it('joins runs within a paragraph and separates paragraphs with newlines', () => {
    const docx = buildDocx(
      wordDocument(
        '<w:p><w:t>Hello </w:t><w:t xml:space="preserve">world</w:t></w:p>' +
          '<w:p><w:t>Second</w:t></w:p>' +
          '<w:p/>',
      ),
    );

    expect(extractDocxText(docx)).toEqual('Hello world\nSecond');
  });

  it('assumes the w prefix when the document declares no namespace', () => {
    const docx = buildDocx(
      '<w:document><w:p><w:t>No xmlns</w:t></w:p></w:document>',
    );

    expect(extractDocxText(docx)).toEqual('No xmlns');
  });

  it('returns an empty string for a document body holding no runs', () => {
    const docx = buildDocx(wordDocument('<w:p/>'));

    expect(extractDocxText(docx)).toEqual('');
  });

  it('returns undefined for a buffer that is not a zip', () => {
    expect(extractDocxText(Buffer.from('not a zip at all', 'utf8'))).toBe(
      undefined,
    );
  });

  it('returns undefined for a zip without a document body', () => {
    const zip = new AdmZip();
    zip.addFile('word/styles.xml', Buffer.from('<styles/>', 'utf8'));

    expect(extractDocxText(zip.toBuffer())).toBeUndefined();
  });

  it('refuses to inflate a document body larger than the cap', () => {
    const oversized =
      `<w:document xmlns:w="${WORDPROCESSINGML_NAMESPACE}"><w:p><w:t>` +
      'A'.repeat(MAX_XML_BYTES) +
      '</w:t></w:p></w:document>';

    expect(extractDocxText(buildDocx(oversized))).toBeUndefined();
  });
});
