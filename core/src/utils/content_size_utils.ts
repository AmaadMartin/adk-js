/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, Part} from '@google/genai';

const textEncoder = new TextEncoder();

/**
 * Part fields whose payload is structured rather than text or inline bytes.
 * Their wire size is approximated by the size of their JSON encoding.
 */
const STRUCTURED_PART_FIELDS = [
  'functionCall',
  'functionResponse',
  'fileData',
  'executableCode',
  'codeExecutionResult',
] as const;

/**
 * Number of bytes a base64 payload decodes to.
 *
 * Computed rather than decoded: this module is reachable from the browser
 * bundle (`index_web.ts` -> `common.ts`), where `Buffer` is not available.
 */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function partSize(part: Part): number {
  let size = 0;
  if (part.text !== undefined && part.text !== null) {
    size += textEncoder.encode(part.text).length;
  }
  if (part.inlineData?.data) {
    size += base64ByteLength(part.inlineData.data);
  }
  for (const field of STRUCTURED_PART_FIELDS) {
    const payload = part[field];
    if (payload !== undefined && payload !== null) {
      size += textEncoder.encode(JSON.stringify(payload)).length;
    }
  }
  return size;
}

/**
 * Approximate size of `content` in bytes: UTF-8 bytes for text, decoded bytes
 * for inline blobs, and the UTF-8 size of the JSON encoding for structured
 * parts (function calls and responses, file references, executable code and
 * its results).
 *
 * Structured parts are counted so that a tool-calling turn, whose content is
 * often a single `functionCall` part, is not reported as 0 bytes: a dashboard
 * cannot tell such a reading apart from an unmeasured response.
 */
export function contentSize(content?: Content | null): number {
  if (!content?.parts) {
    return 0;
  }
  return content.parts.reduce((total, part) => total + partSize(part), 0);
}
