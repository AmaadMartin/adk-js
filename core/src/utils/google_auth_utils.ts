/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for authenticating to a Google Cloud REST service with either
 * service account key material or Application Default Credentials.
 */

import {AuthClient, GoogleAuth, JWTInput} from 'google-auth-library';
import {formatError} from './error_utils.js';

/** OAuth 2.0 scope that grants access to Google Cloud APIs. */
export const CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';

/**
 * Parses the contents of a service account JSON keyfile.
 *
 * @param serviceAccountJson The keyfile itself, as a string, not a path to it.
 * @throws If the string is not valid JSON.
 */
export function parseServiceAccountJson(serviceAccountJson: string): JWTInput {
  try {
    return JSON.parse(serviceAccountJson) as JWTInput;
  } catch (error: unknown) {
    throw new Error(`Invalid service account JSON: ${formatError(error)}`, {
      cause: error,
    });
  }
}

/**
 * Resolves an authenticated client from service account key material, or from
 * Application Default Credentials when `serviceAccount` is omitted.
 *
 * The whole keyfile reaches `GoogleAuth`, so fields beyond the client email
 * and the private key, such as `token_uri` and `universe_domain`, are
 * honoured.
 */
export function resolveGoogleAuthClient(
  serviceAccount?: JWTInput,
): Promise<AuthClient> {
  return new GoogleAuth({
    credentials: serviceAccount,
    scopes: [CLOUD_PLATFORM_SCOPE],
  }).getClient();
}
