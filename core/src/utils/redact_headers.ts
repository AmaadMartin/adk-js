/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Header names whose value is a credential. Matched case-insensitively,
 * because HTTP header names are case-insensitive and servers spell them
 * however they like.
 */
const SENSITIVE_HEADERS = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

/** The value written in place of a credential. */
const REDACTED = '<redacted>';

/**
 * Returns a copy of `headers` with every credential value replaced by
 * `<redacted>`.
 *
 * Recorded HTTP exchanges end up in debug buffers, log files and bug-report
 * attachments, which is frequently a different trust boundary from whoever
 * holds the credential. Non-sensitive headers pass through verbatim so the
 * record stays useful. The input object is never mutated.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_HEADERS.has(name.toLowerCase())
      ? REDACTED
      : value;
  }
  return redacted;
}
