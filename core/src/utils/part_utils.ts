/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

const GEMINI_SUPPORTED_INLINE_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const GEMINI_SUPPORTED_INLINE_MIME_TYPES = new Set(['application/pdf']);
const TEXT_LIKE_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/xml',
]);

function normalizeMimeType(mimeType?: string): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  return mimeType.split(';')[0].trim();
}

function isInlineMimeTypeSupported(mimeType?: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return false;
  }
  return (
    GEMINI_SUPPORTED_INLINE_MIME_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    ) || GEMINI_SUPPORTED_INLINE_MIME_TYPES.has(normalized)
  );
}

/**
 * Converts a part the model cannot read into one it can.
 *
 * A part whose inline MIME type Gemini supports is returned as it is.
 * Anything else becomes a text part: the decoded text for a text-like type, or
 * a short description naming the artifact otherwise.
 *
 * @param artifact The part to convert.
 * @param artifactName The name to quote in the description.
 * @returns A part that is safe to send to the model.
 */
export function asSafePartForLlm(artifact: Part, artifactName: string): Part {
  const inlineData = artifact.inlineData;
  if (!inlineData) {
    return artifact;
  }

  if (isInlineMimeTypeSupported(inlineData.mimeType)) {
    return artifact;
  }

  const mimeType =
    normalizeMimeType(inlineData.mimeType) || 'application/octet-stream';
  const data = inlineData.data;
  if (!data) {
    return {
      text: `[Artifact: ${artifactName}, type: ${mimeType}. No inline data was provided.]`,
    };
  }

  const isTextLike =
    mimeType.startsWith('text/') || TEXT_LIKE_MIME_TYPES.has(mimeType);

  const decodedBuffer = Buffer.from(data, 'base64');
  if (isTextLike) {
    try {
      const decoded = decodedBuffer.toString('utf8');
      return {text: decoded};
    } catch {
      // A buffer over Node's maximum string length cannot be decoded, so the
      // size description below is all that is left to send.
    }
  }

  const sizeKb = decodedBuffer.length / 1024;
  return {
    text: `[Binary artifact: ${artifactName}, type: ${mimeType}, size: ${sizeKb.toFixed(1)} KB. Content cannot be displayed inline.]`,
  };
}
