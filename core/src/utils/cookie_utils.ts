/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Appends a cookie to the `Cookie` request header, keeping any cookie the
 * header already carries.
 *
 * HTTP sends every cookie in one `Cookie` header as `name=value` pairs joined
 * by `'; '`, so a second header entry would be joined with `', '` and be
 * invalid. The value is percent-encoded, because a raw `;` or `=` in a
 * model-supplied value would otherwise forge an extra cookie.
 *
 * @param headers The request headers, mutated in place.
 * @param name The cookie name, written verbatim.
 * @param value The cookie value.
 */
export function appendCookie(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  // Header names are case-insensitive, so reuse the existing key as spelled
  // rather than adding a second entry under the canonical one.
  const key =
    Object.keys(headers).find((h) => h.toLowerCase() === 'cookie') ?? 'Cookie';
  const cookie = `${name}=${encodeURIComponent(value)}`;
  headers[key] = headers[key] ? `${headers[key]}; ${cookie}` : cookie;
}
