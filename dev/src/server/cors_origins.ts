/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CORS origin parsing for the dev server (adk web / api_server).
 *
 * An `allowOrigins` entry prefixed with `regex:` names a pattern rather than a
 * literal origin, so an operator serving per-tenant subdomains can accept them
 * all with one entry. This mirrors adk-python's `_parse_cors_origins`.
 */

/** Prefix marking an `allowOrigins` entry as a regular expression. */
const REGEX_PREFIX = 'regex:';

/** The literal origins and the combined pattern an origin list denotes. */
export interface ParsedCorsOrigins {
  /** Origins matched literally, in the order they were given. */
  origins: string[];
  /**
   * Every `regex:` entry joined into one anchored pattern, or `undefined` when
   * the list held none.
   */
  originRegex?: RegExp;
}

/**
 * Splits `allowOrigins` into literal origins and one combined pattern.
 *
 * The pattern is anchored. adk-python hands the joined pattern to Starlette,
 * which applies `re.fullmatch`, whereas `RegExp.prototype.test` searches, so an
 * unanchored pattern would let `regex:https://.*\.example\.com` accept
 * `https://a.example.com.evil.com`.
 *
 * An invalid pattern propagates the `SyntaxError` from `new RegExp`, as
 * adk-python propagates `re.error` from `re.compile`.
 */
export function parseCorsOrigins(
  allowOrigins: string | readonly string[] | undefined,
): ParsedCorsOrigins {
  const entries =
    typeof allowOrigins === 'string' ? [allowOrigins] : (allowOrigins ?? []);

  const origins: string[] = [];
  const patterns: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(REGEX_PREFIX)) {
      const pattern = entry.slice(REGEX_PREFIX.length);
      if (pattern) {
        patterns.push(pattern);
      }
    } else {
      origins.push(entry);
    }
  }

  if (patterns.length === 0) {
    return {origins};
  }
  // The non-capturing group keeps the alternation inside the anchors.
  return {origins, originRegex: new RegExp(`^(?:${patterns.join('|')})$`)};
}

/**
 * Builds the `origin` option handed to the `cors` middleware.
 *
 * `cors` reads the bare string `'*'` as "accept every origin", but compares the
 * array element `'*'` to the request's Origin with `===`, so a wildcard must
 * stay a string.
 */
export function corsOriginOption({
  origins,
  originRegex,
}: ParsedCorsOrigins): string | Array<string | RegExp> {
  if (origins.includes('*')) {
    return '*';
  }
  return originRegex ? [...origins, originRegex] : origins;
}
