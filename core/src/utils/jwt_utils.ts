/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Number of dot-separated segments in a JWT: header, payload, signature. */
const JWT_SEGMENT_COUNT = 3;

/**
 * Reads the `exp` claim of a JWT, in seconds since the epoch, or `undefined`
 * when the argument is not a JWT carrying a finite `exp`.
 *
 * The token is not verified. Use this only to schedule work around a token
 * whose issuer you already trust, never to decide whether to accept one.
 * Never throws, and never surfaces the payload.
 *
 * Decoding is `base64url`, not `base64`, so {@link base64Decode} in
 * `env_aware_utils` does not fit: a JWT payload uses the `-` and `_` alphabet
 * and omits padding, which `window.atob` rejects.
 *
 * @param token The encoded JWT.
 * @return The `exp` claim in seconds, or `undefined`.
 */
export function readJwtExpirySeconds(token: string): number | undefined {
  const segments = token.split('.');
  if (segments.length !== JWT_SEGMENT_COUNT) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof claims !== 'object' || claims === null || !('exp' in claims)) {
    return undefined;
  }
  const exp = claims.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
}
