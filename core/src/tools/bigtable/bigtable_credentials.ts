/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigtableOptions} from '@google-cloud/bigtable';

/**
 * How the Bigtable tools authenticate.
 *
 * This is the authentication subset of the Bigtable SDK's own options
 * (`BigtableOptions extends GoogleAuthOptions`), so the values are forwarded
 * verbatim to the client. Picking from `BigtableOptions` rather than from
 * `google-auth-library` directly matters: the SDK resolves `AuthClient`
 * through its own `google-gax` copy of the auth library, and the two copies
 * are not assignable to each other.
 *
 * The target project is not part of this config; it is supplied per call by
 * the tool arguments.
 *
 * Prefer `authClient` over `keyFilename`: the latter is deprecated by
 * `google-auth-library` because it loads a credential configuration without
 * validating it.
 */
export type BigtableCredentialsConfig = Pick<
  BigtableOptions,
  'scopes' | 'keyFilename' | 'authClient'
>;

/** Scopes requested when the caller does not specify any. */
export const BIGTABLE_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];
