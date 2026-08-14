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
 * invalid.
 *
 * The value is written verbatim. Servers do not percent-decode cookie values,
 * so encoding here would hand the application a different value than the
 * caller supplied — a base64 session token is the common casualty. A caller
 * whose value is untrusted passes it through `checkCookieValue` first.
 *
 * @param headers The request headers, mutated in place.
 * @param name The cookie name, written verbatim.
 * @param value The cookie value, written verbatim.
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
  const cookie = `${name}=${value}`;
  headers[key] = headers[key] ? `${headers[key]}; ${cookie}` : cookie;
}

const ILLEGAL_COOKIE_VALUE_CHARS = /[;\r\n\0]/;

/**
 * Rejects a cookie value that would change the shape of the request.
 *
 * A `;` opens a second cookie the caller never declared, and a carriage
 * return, line feed or NUL splits the header line. They are rejected rather
 * than encoded, because `appendCookie` writes the value verbatim.
 *
 * @param name The cookie name, used to name the offender in the error.
 * @param value The untrusted cookie value.
 * @throws {Error} If the value contains `;`, CR, LF or NUL.
 */
export function checkCookieValue(name: string, value: string): void {
  if (ILLEGAL_COOKIE_VALUE_CHARS.test(value)) {
    throw new Error(
      `Invalid value for cookie parameter '${name}': ';', carriage return, ` +
        `line feed and NUL are not allowed.`,
    );
  }
}
