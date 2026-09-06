/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Only the router and the seam that configures it are public, matching
// adk-python, which keeps the credentials providers and their client private.
// `GcpAuthProviderScheme` stays public through `integrations/agent_registry`.
// An interface is erased at build time, so it must leave through `export type`;
// a value re-export of an erased name makes the built ESM module fail to load.
export type {CredentialsProvider} from './agent_identity_credentials_provider.js';
export {GcpAuthProvider} from './gcp_auth_provider.js';
export type {GcpAuthProviderOptions} from './gcp_auth_provider.js';
