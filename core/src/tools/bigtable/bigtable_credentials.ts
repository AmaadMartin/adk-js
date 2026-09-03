/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigtableOptions} from '@google-cloud/bigtable';

/**
 * OAuth scopes the Bigtable tools request when the developer does not name
 * their own. Matches `BIGTABLE_DEFAULT_SCOPE` in adk-python.
 */
export const BIGTABLE_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];

/**
 * How the Bigtable tools authenticate.
 *
 * This is the authentication subset of the SDK's own client options, so it is
 * spread straight into the `Bigtable` constructor and cannot drift from what
 * the SDK accepts. Leave it unset to use Application Default Credentials.
 */
export type BigtableCredentialsConfig = Pick<
  BigtableOptions,
  'credentials' | 'keyFilename' | 'scopes'
>;
