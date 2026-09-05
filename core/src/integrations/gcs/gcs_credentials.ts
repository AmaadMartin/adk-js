/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {StorageOptions} from '@google-cloud/storage';

/** The OAuth scope the Cloud Storage tools request when none is supplied. */
export const GCS_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/devstorage.full_control',
];

/**
 * How a {@link GcsToolset} authenticates to Cloud Storage.
 *
 * The fields are taken from the Cloud Storage SDK's own `StorageOptions`, so
 * they forward to the client verbatim. Supply a key file, inline credentials
 * or an `AuthClient`; omit all three to use Application Default Credentials.
 *
 * adk-python's `GCSCredentialsConfig` instead carries an OAuth `client_id` and
 * `client_secret` and runs an interactive end-user handshake. That flow lives
 * in `GoogleTool`, which adk-js does not have on this branch, so this port
 * authenticates at the client level.
 */
export type GcsCredentialsConfig = Pick<
  StorageOptions,
  'scopes' | 'keyFilename' | 'authClient' | 'credentials'
>;
