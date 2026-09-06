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
 * Converts a part the model cannot read inline into a text part it can.
 *
 * A part whose inline MIME type the model accepts is returned as it is. Any
 * other inline part becomes text: the decoded content for a text-like type,
 * and a short summary naming the type and the size otherwise.
 *
 * @param artifact The part to send to the model.
 * @param artifactName The name reported in the text of an unreadable part.
 * @return The original part, or a text part describing it.
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
      // Fallback
    }
  }

  const sizeKb = decodedBuffer.length / 1024;
  return {
    text: `[Binary artifact: ${artifactName}, type: ${mimeType}, size: ${sizeKb.toFixed(1)} KB. Content cannot be displayed inline.]`,
  };
}
