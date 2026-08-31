/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Header names whose value is a credential. Compared lower-cased, because HTTP
 * header names are case-insensitive.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

/** The value written in place of a credential. */
export const REDACTED_HEADER_VALUE = '<redacted>';

/**
 * Returns a copy of `headers` with every credential-bearing value replaced by
 * {@link REDACTED_HEADER_VALUE}.
 *
 * Anything that records or logs HTTP headers must run them through here first:
 * a debug capture is routinely attached to a bug report, which is a different
 * trust boundary from whoever holds the credential.
 *
 * @param headers The headers to redact, keyed by header name.
 * @returns A new object with the same keys and the sensitive values masked.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADER_NAMES.has(name.toLowerCase())
        ? REDACTED_HEADER_VALUE
        : value,
    ]),
  );
}
