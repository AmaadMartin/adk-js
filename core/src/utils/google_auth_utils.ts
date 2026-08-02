/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The header collection an auth client returns: `google-auth-library` v10
 * returns a `Headers` instance, earlier versions a plain record.
 */
export type RequestHeaders = Headers | Record<string, unknown>;

/** The subset of an auth client {@link getGoogleAuthHeaders} reads. */
export interface GoogleAuthRequestClient {
  getRequestHeaders(url?: string | URL): Promise<RequestHeaders>;
  readonly credentials?: {access_token?: string | null};
  readonly quotaProjectId?: string;
}

/**
 * The subset of `GoogleAuth` needed to mint request headers.
 *
 * `quotaProjectId` is read only as a fallback: `google-auth-library` attaches
 * the quota project to the client it mints rather than to the auth object.
 */
export interface GoogleAuthCredentialSource {
  getClient(): Promise<GoogleAuthRequestClient>;
  readonly quotaProjectId?: string;
}

/**
 * Resolves Google Cloud credentials and returns standard request headers.
 *
 * Token caching, fetching and refreshing are handled by the auth client. The
 * billing/quota project identifier `x-goog-user-project` is injected when one
 * is configured.
 *
 * @param auth The auth object used to mint a client.
 * @param url The URL the returned headers will be sent to.
 * @throws If the credentials cannot be resolved.
 */
export async function getGoogleAuthHeaders(
  auth: GoogleAuthCredentialSource,
  url: string,
): Promise<Record<string, string>> {
  try {
    const client = await auth.getClient();
    const requestHeaders = await client.getRequestHeaders(url);
    const authHeaders: Record<string, string> = {};

    let token = readHeader(requestHeaders, 'authorization');

    // Fall back to the populated credentials object if headers are empty.
    const accessToken = client.credentials?.access_token;
    if (!token && accessToken) {
      token = `Bearer ${accessToken}`;
    }

    if (token) {
      authHeaders['Authorization'] = token;
    }
    authHeaders['Content-Type'] = 'application/json';

    const quotaProjectId = client.quotaProjectId || auth.quotaProjectId;
    if (quotaProjectId) {
      authHeaders['x-goog-user-project'] = quotaProjectId;
    }
    return authHeaders;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to refresh Google Cloud credentials: ${msg}`);
  }
}

/**
 * Reads a header case-insensitively from either a `Headers` instance or a
 * plain header record.
 */
function readHeader(headers: RequestHeaders, name: string): string | undefined {
  if ('get' in headers && typeof headers.get === 'function') {
    const value: unknown = headers.get(name);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}
