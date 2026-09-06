/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Only the scheme and the router are public, matching adk-python, which keeps
// the credentials providers and their client private. `GcpAuthProviderScheme`
// is declared in `auth/auth_schemes` and reaches a user through this module.
// An interface is erased at build time, so it must leave through `export type`;
// a value re-export of an erased name makes the built ESM module fail to load.
export {GcpAuthProvider} from './gcp_auth_provider.js';
export type {GcpAuthProviderScheme} from './gcp_auth_provider_scheme.js';
