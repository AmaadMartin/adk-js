/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** MIME type prefixes Gemini accepts for inline data in requests. */
const GEMINI_SUPPORTED_INLINE_MIME_PREFIXES = ['image/', 'audio/', 'video/'];

/** Exact MIME types Gemini accepts for inline data in requests. */
const GEMINI_SUPPORTED_INLINE_MIME_TYPES = new Set(['application/pdf']);

/**
 * MIME subtypes that match a supported prefix above but that Gemini rejects
 * with 400 INVALID_ARGUMENT when they are sent as inline data. Callers must
 * convert these to text instead of forwarding them as inline image data.
 */
const GEMINI_UNSUPPORTED_INLINE_SUBTYPES = new Set([
  'image/svg',
  'image/svg+xml',
  'image/xml',
]);

/**
 * MIME types whose payload is text even though the type is not under `text/`.
 * The SVG and XML image variants are here because they are XML documents and
 * Gemini rejects them as inline image data.
 */
const TEXT_LIKE_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/svg+xml',
  'application/xml',
  'image/svg',
  'image/svg+xml',
  'image/xml',
]);

/**
 * Strips parameters such as `charset` from a MIME type and trims it.
 *
 * @param mimeType The raw MIME type, for example `text/csv; charset=utf-8`.
 * @return The bare type, or `undefined` when `mimeType` is empty.
 */
export function normalizeMimeType(mimeType?: string): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  return mimeType.split(';')[0].trim();
}

/**
 * Returns whether Gemini accepts this MIME type as inline data.
 *
 * @param mimeType The MIME type to test; parameters are ignored.
 * @return True when the type may be sent as an inline data part.
 */
export function isGeminiInlineMimeTypeSupported(mimeType?: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return false;
  }
  if (GEMINI_UNSUPPORTED_INLINE_SUBTYPES.has(normalized)) {
    return false;
  }
  return (
    GEMINI_SUPPORTED_INLINE_MIME_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    ) || GEMINI_SUPPORTED_INLINE_MIME_TYPES.has(normalized)
  );
}

/**
 * Returns whether the payload of this MIME type is text.
 *
 * @param mimeType The normalized MIME type to test.
 * @return True when the payload should be decoded as text.
 */
export function isTextLikeMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || TEXT_LIKE_MIME_TYPES.has(mimeType);
}
