/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
// `asSafePartForLlm` is internal and deliberately not exported from the
// package barrel.
import {asSafePartForLlm} from '../../src/utils/safe_part_utils.js';

/** Base64 of the given text, as an inline part carries it. */
function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('asSafePartForLlm', () => {
  it('returns a part without inline data unchanged', () => {
    const part: Part = {text: 'hello'};

    expect(asSafePartForLlm(part, 'note.txt')).toBe(part);
  });

  it('returns a supported image unchanged', () => {
    const part: Part = {
      inlineData: {mimeType: 'image/png', data: base64('pixels')},
    };

    expect(asSafePartForLlm(part, 'shot.png')).toBe(part);
  });

  it('returns a PDF unchanged', () => {
    const part: Part = {
      inlineData: {mimeType: 'application/pdf', data: base64('%PDF')},
    };

    expect(asSafePartForLlm(part, 'doc.pdf')).toBe(part);
  });

  it('decodes a text type, ignoring its parameters', () => {
    const part: Part = {
      inlineData: {
        mimeType: 'text/plain; charset=utf-8',
        data: base64('line one'),
      },
    };

    expect(asSafePartForLlm(part, 'note.txt')).toEqual({text: 'line one'});
  });

  it('decodes a text-like application type', () => {
    const part: Part = {
      inlineData: {mimeType: 'application/json', data: base64('{"a":1}')},
    };

    expect(asSafePartForLlm(part, 'data.json')).toEqual({text: '{"a":1}'});
  });

  it('summarizes an unsupported binary type', () => {
    const part: Part = {
      inlineData: {mimeType: DOCX_MIME_TYPE, data: base64('x'.repeat(2048))},
    };

    const safePart = asSafePartForLlm(part, 'report.docx');

    expect(safePart.inlineData).toBeUndefined();
    expect(safePart.text).toBe(
      `[Binary artifact: report.docx, type: ${DOCX_MIME_TYPE}, size: 2.0 KB.` +
        ' Content cannot be displayed inline.]',
    );
  });

  it('falls back to a generic type when none is given', () => {
    const part: Part = {inlineData: {data: base64('bytes')}};

    expect(asSafePartForLlm(part, 'blob')).toEqual({
      text:
        '[Binary artifact: blob, type: application/octet-stream, size: 0.0 KB.' +
        ' Content cannot be displayed inline.]',
    });
  });

  it('reports an unsupported part that carries no data', () => {
    const part: Part = {inlineData: {mimeType: DOCX_MIME_TYPE}};

    expect(asSafePartForLlm(part, 'report.docx')).toEqual({
      text: `[Artifact: report.docx, type: ${DOCX_MIME_TYPE}. No inline data was provided.]`,
    });
  });
});
