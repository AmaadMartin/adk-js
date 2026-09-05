/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  AgentIdentityCredentialsClient,
  RestAgentIdentityCredentialsClient,
  RetrieveCredentialsRequest,
  RetrieveCredentialsResponse,
  RetrieveCredentialsSuccess,
  UriConsentRequired,
} from './agent_identity_credentials_client.js';
export {
  AgentIdentityCredentialsProvider,
  AgentIdentityCredentialsProviderOptions,
  CredentialsProvider,
  constructAuthCredential,
  isConsentCompleted,
} from './agent_identity_credentials_provider.js';
export {
  GCP_AUTH_PROVIDER_SCHEME_TYPE,
  GcpAuthProvider,
  GcpAuthProviderOptions,
  isGcpAuthProviderScheme,
} from './gcp_auth_provider.js';
