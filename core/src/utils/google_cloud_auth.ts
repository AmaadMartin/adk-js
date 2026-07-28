/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';

/**
 * Resolves Application Default Credentials and returns the standard headers for
 * a Google Cloud REST request.
 *
 * Performs a case-insensitive `Authorization` lookup with a fallback to the
 * client's populated credentials, sets the JSON content type, and injects the
 * optional `x-goog-user-project` quota/billing project. Refresh failures are
 * rethrown with a descriptive message.
 *
 * @param auth A configured {@link GoogleAuth} instance (with the required
 *     scopes).
 * @param url The request URL, used to resolve the auth headers.
 */
export async function getGoogleCloudAuthHeaders(
  auth: GoogleAuth,
  url: string,
): Promise<Record<string, string>> {
  try {
    const client = await auth.getClient();
    const rawHeaders = (await client.getRequestHeaders(
      url,
    )) as unknown as Record<string, string>;
    const authKey = Object.keys(rawHeaders).find(
      (k) => k.toLowerCase() === 'authorization',
    );
    let token = authKey ? rawHeaders[authKey] : undefined;
    const accessToken = (client.credentials as {access_token?: string})
      ?.access_token;
    if (!token && accessToken) {
      token = `Bearer ${accessToken}`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = token;
    }
    const quotaProjectId =
      (client as unknown as {quotaProjectId?: string}).quotaProjectId ||
      (auth as unknown as {quotaProjectId?: string}).quotaProjectId;
    if (quotaProjectId) {
      headers['x-goog-user-project'] = quotaProjectId;
    }
    return headers;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to refresh Google Cloud credentials: ${msg}`);
  }
}
