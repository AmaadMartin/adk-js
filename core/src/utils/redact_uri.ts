/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Redacts the credentials a URI carries.
 *
 * Two callers want this, and they want different amounts of it.
 * {@link redactUriPassword} guards a connection or callback URI on its way
 * into a log line, and keeps the rest of the URI readable for debugging.
 * {@link sanitizeExternalUri} guards a model-supplied URI on its way into
 * durable telemetry, where a signed URL is a credential written as a link, so
 * it inspects every surface that can carry one — userinfo, path segments,
 * query parameters and the fragment.
 *
 * They share {@link SECRET_QUERY_PARAMS}, so a parameter name added for one is
 * recognized by the other.
 */

import {
  isSensitiveKey,
  MAX_INSPECT_CHARS,
  NO_LENGTH_LIMIT,
  sanitizeErrorText,
  truncateText,
} from './sanitize_utils.js';

/**
 * Query parameters that carry a credential in a URL but are ordinary words as
 * object keys. {@link isSensitiveKey} classifies structured payloads, where
 * redacting every `code` would blank an `executable_code.code` body, so these
 * names are recognized in a query string only.
 */
const SECRET_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'sslpassword',
  // An OAuth2 callback URI carries its secrets as query parameters rather than
  // in userinfo: an authorization `code` is a single-use, bearer-equivalent
  // credential, and a token response echoed back through a URI can carry
  // `access_token`, `id_token` or `refresh_token`. `client_secret` is not
  // meant to travel in a URL at all, but a misconfigured flow puts it there.
  'code',
  'access_token',
  'id_token',
  'refresh_token',
  'client_secret',
  'code_verifier',
]);

/** Whether `name` names a credential when it is a URL query parameter. */
function isSecretQueryParam(name: string): boolean {
  return SECRET_QUERY_PARAMS.has(name.toLowerCase()) || isSensitiveKey(name);
}

/** Replaces a URI that cannot be stored with any part of it intact. */
const REDACTED_SENSITIVE_URI = '[REDACTED_SENSITIVE_URI]';

/** Replaces one URI component whose escapes decode to a credential. */
const REDACTED_SENSITIVE_TEXT = '[REDACTED_SENSITIVE_TEXT]';

/** Replaces the name or the value of a credential-bearing pair. */
const REDACTED = '[REDACTED]';

/**
 * Percent-decoding rounds one component may take. An escape can hide another
 * escape (`%255F` decodes to `%5F`, then to `_`), so one round is not enough,
 * and an unbounded loop is work an adversarial URI controls.
 */
const MAX_DECODE_ROUNDS = 4;

/** The outcome of sanitizing one URI. */
export interface SanitizedUri {
  /** The URI to store. */
  uri: string;
  /** Whether anything was redacted or cut. */
  changed: boolean;
}

/**
 * Decodes `text` until its percent escapes stop revealing new ones.
 *
 * The result is for detection only. It is never stored, because mapping a
 * decoded credential back onto the source offsets is not something a caller
 * can do safely.
 */
function canonicalize(text: string): string {
  let current = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (decoded === current) {
      return current;
    }
    current = decoded;
  }
  return current;
}

/**
 * Redacts the credentials in one URI component.
 *
 * The component takes the free-text pass first, which catches a credential
 * written in the clear. It then takes the pass again over its decoded form: a
 * component whose escapes decode to a credential is replaced whole, because
 * rewriting the credential in place would need a source-to-decoded offset map
 * that percent-encoding does not provide.
 *
 * @param text The component to sanitize.
 * @return The component to store and whether it changed.
 */
function sanitizeUriText(text: string): {text: string; changed: boolean} {
  const redacted = sanitizeErrorText(text, NO_LENGTH_LIMIT).text;
  if (redacted !== text) {
    return {text: redacted, changed: true};
  }
  const canonical = canonicalize(text);
  if (
    canonical !== text &&
    sanitizeErrorText(canonical, NO_LENGTH_LIMIT).text !== canonical
  ) {
    return {text: REDACTED_SENSITIVE_TEXT, changed: true};
  }
  return {text, changed: false};
}

/**
 * Redacts the credential-bearing segments of `pathname`.
 *
 * A path can spell a key/value pair with slashes, so a segment naming a
 * credential redacts the segment after it too: `/token/abc123/` hides the same
 * secret `?token=abc123` does.
 */
function sanitizePath(pathname: string): {path: string; changed: boolean} {
  const segments = pathname.split('/');
  let changed = false;
  let redactNext = false;
  segments.forEach((segment, index) => {
    if (segment === '') {
      return;
    }
    if (redactNext) {
      segments[index] = encodeURIComponent(REDACTED);
      changed = true;
      redactNext = false;
      return;
    }
    if (isSensitiveKey(canonicalize(segment))) {
      segments[index] = encodeURIComponent(REDACTED);
      changed = true;
      redactNext = true;
      return;
    }
    const safe = sanitizeUriText(segment);
    if (safe.changed) {
      segments[index] = encodeURIComponent(safe.text);
      changed = true;
    }
  });
  return {path: segments.join('/'), changed};
}

/**
 * Redacts the credential-bearing parameters of `params`.
 *
 * A blank value is kept rather than dropped, so a parameter that was present
 * and empty still reads as present in the stored URI.
 */
function sanitizeQuery(params: URLSearchParams): {
  query: URLSearchParams;
  changed: boolean;
} {
  const safe = new URLSearchParams();
  let changed = false;
  for (const [key, value] of params) {
    if (isSecretQueryParam(key)) {
      safe.append(key, REDACTED);
      changed = true;
      continue;
    }
    const safeKey = sanitizeUriText(key);
    const safeValue = sanitizeUriText(value);
    safe.append(safeKey.text, safeValue.text);
    changed = changed || safeKey.changed || safeValue.changed;
  }
  return {query: safe, changed};
}

/**
 * Returns `uri` with its credentials redacted and its length bounded.
 *
 * A URI that cannot be stored with any part intact comes back as
 * `[REDACTED_SENSITIVE_URI]`: one that is not a string, one longer than
 * {@link MAX_INSPECT_CHARS}, one that carries userinfo, one no URL parser
 * accepts, and one whose path refuses the redaction. Userinfo redacts the
 * whole URI because it is credential-bearing by definition, and a username is
 * not worth guessing about.
 *
 * @param uri The URI a model, a tool or a user supplied.
 * @param maxLength Maximum length of the result, or -1 for no limit.
 * @return The URI to store and whether anything was redacted or cut.
 */
export function sanitizeExternalUri(
  uri: unknown,
  maxLength: number,
): SanitizedUri {
  if (typeof uri !== 'string' || uri.length > MAX_INSPECT_CHARS) {
    return {uri: REDACTED_SENSITIVE_URI, changed: true};
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return {uri: REDACTED_SENSITIVE_URI, changed: true};
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {uri: REDACTED_SENSITIVE_URI, changed: true};
  }

  const path = sanitizePath(parsed.pathname);
  const query = sanitizeQuery(parsed.searchParams);
  const fragment = sanitizeUriText(parsed.hash.replace(/^#/, ''));

  parsed.pathname = path.path;
  if (parsed.pathname !== path.path) {
    // The `pathname` setter does nothing on a URL that cannot be a base — a
    // `data:`, `mailto:` or `blob:` URI. Writing the URI back would return the
    // credential the path pass just found, so the whole URI is refused.
    return {uri: REDACTED_SENSITIVE_URI, changed: true};
  }
  parsed.search = query.query.toString();
  parsed.hash = fragment.text;
  const bounded = truncateText(parsed.href, maxLength);
  return {
    uri: bounded.text,
    changed:
      path.changed || query.changed || fragment.changed || bounded.truncated,
  };
}

/**
 * Redacts credentials from a URI so it can be safely included in error
 * messages and logs.
 *
 * A database or session-service connection URI such as
 * `postgres://user:password@host:5432/db` embeds the password in its userinfo
 * component. An OAuth2 callback/authorization-response URI instead carries
 * its secret (an authorization code, or an echoed token) as a query
 * parameter, for example `https://app/callback?code=SECRET&state=xyz`.
 * Including either verbatim in a thrown Error or log entry leaks the
 * credential to wherever those are collected (log files, error-tracking
 * services, stdout captured by an orchestrator), which is frequently a
 * different trust boundary from whoever holds the credential.
 *
 * The same connection-string credential can also arrive as a query
 * parameter rather than userinfo, for example
 * `postgres://user@host/db?password=secret`, which several drivers accept
 * and which reaches the same error paths. All forms above are masked.
 *
 * The rest of the URI is kept intact for debugging, mirroring the semantics of
 * Go's `net/url.URL.Redacted()`. A URI carrying no credential is returned
 * unchanged, byte for byte.
 *
 * If the input cannot be parsed as a URL, only its scheme prefix is returned so
 * that a credential embedded in an otherwise-unparseable string is not leaked.
 */
export function redactUriPassword(uri: string): string {
  try {
    const url = new URL(uri);
    let redacted = false;

    if (url.password) {
      url.password = '***';
      redacted = true;
    }

    for (const name of [...url.searchParams.keys()]) {
      if (isSecretQueryParam(name)) {
        url.searchParams.set(name, '***');
        redacted = true;
      }
    }

    return redacted ? url.toString() : uri;
  } catch {
    const schemeEnd = uri.indexOf('://');
    return schemeEnd === -1
      ? '<unparseable URI, redacted>'
      : `${uri.slice(0, schemeEnd)}://<unparseable URI, redacted>`;
  }
}
