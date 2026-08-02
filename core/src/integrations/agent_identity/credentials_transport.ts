/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {getGoogleAuthHeaders} from '../../utils/google_auth_utils.js';

/** ADC scope required by both credentials services. */
export const CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';

/**
 * Resolves the base URL of a credentials service.
 *
 * @param envVar Name of the environment variable overriding the host.
 * @param defaultHost Host used when the environment variable is unset.
 */
export function resolveBaseUrl(envVar: string, defaultHost: string): string {
  const host = process.env[envVar];
  if (!host) {
    return `https://${defaultHost}`;
  }
  return host.includes('://') ? host : `https://${host}`;
}

/**
 * Minimal JSON-over-HTTPS client for a Google Cloud API, authenticated with
 * Application Default Credentials.
 */
export class GoogleApiJsonClient {
  private readonly auth: GoogleAuth;

  constructor(private readonly baseUrl: string) {
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  }

  /**
   * Sends `body` as JSON to `path` and parses the JSON response.
   *
   * @throws If the service responds with a non-2xx status. The response body
   *     is deliberately omitted from the message because it may echo token
   *     material.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = await getGoogleAuthHeaders(this.auth, url);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Credentials request failed with status ${response.status}.`,
      );
    }
    return (await response.json()) as T;
  }
}
