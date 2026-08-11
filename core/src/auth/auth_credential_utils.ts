/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from './auth_credential.js';

/**
 * Renders an HTTP {@link AuthCredential} as request headers.
 *
 * This covers the two shapes an auth provider returns: a bearer-style
 * `http.scheme` plus `http.credentials.token`, which becomes an
 * `Authorization` header, and `http.additionalHeaders`, which is copied
 * verbatim. A provider that emits both wins with its additional headers.
 * Any other credential yields no headers.
 */
export function toAuthHeaders(
  credential: AuthCredential,
): Record<string, string> {
  const {http} = credential;
  if (!http) {
    return {};
  }

  const headers: Record<string, string> = {};
  if (http.scheme && http.credentials.token) {
    headers['Authorization'] = `${http.scheme} ${http.credentials.token}`;
  }
  return {...headers, ...http.additionalHeaders};
}
