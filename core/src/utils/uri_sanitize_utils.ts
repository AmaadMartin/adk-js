/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Redacts the credentials a URI carries while keeping the location it names.
 *
 * A signed URL is a credential written as a link: the bearer of the string can
 * read the object. Telemetry that stores such a URI verbatim turns a bounded
 * grant into a durable one, so every surface of the URI that can carry a
 * credential — userinfo, path segments, query parameters, the fragment — is
 * inspected before the value is persisted.
 *
 * This is the pass for a URI that is being stored. It fails closed: a URI it
 * cannot verify is replaced whole, so the result may not be readable. For a
 * URI going into a log line or an error message, where the location has to
 * stay legible, use `redactUriPassword` in `redact_uri.ts` instead.
 */

import {
  isSensitiveKey,
  MAX_INSPECT_CHARS,
  NO_LENGTH_LIMIT,
  sanitizeErrorText,
  truncateText,
} from './sanitize_utils.js';

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
    if (isSensitiveKey(key)) {
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
 * {@link MAX_INSPECT_CHARS}, one that carries userinfo, and one no URL parser
 * accepts. Userinfo redacts the whole URI because it is credential-bearing by
 * definition, and a username is not worth guessing about.
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
  parsed.search = query.query.toString();
  parsed.hash = fragment.text;
  const bounded = truncateText(parsed.href, maxLength);
  return {
    uri: bounded.text,
    changed:
      path.changed || query.changed || fragment.changed || bounded.truncated,
  };
}
