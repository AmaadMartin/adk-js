/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';

/**
 * Resolves Application Default Credentials into request headers.
 *
 * The credentials are read on every call rather than cached, so a long-lived
 * process keeps working after its access token expires.
 *
 * @param auth The `GoogleAuth` instance holding the wanted scopes.
 * @param audience The URL the headers are minted for.
 * @returns The `Authorization` header, plus `x-goog-user-project` when the
 *   credentials name a quota project. Empty when the credentials carry no
 *   authorization header.
 */
export async function resolveAuthHeaders(
  auth: GoogleAuth,
  audience: string,
): Promise<Record<string, string>> {
  const client = await auth.getClient();
  const requestHeaders = await client.getRequestHeaders(audience);
  const headers: Record<string, string> = {};
  const authorization = requestHeaders.get('authorization');
  if (authorization) {
    headers['Authorization'] = authorization;
  }
  if (client.quotaProjectId) {
    headers['x-goog-user-project'] = client.quotaProjectId;
  }
  return headers;
}
