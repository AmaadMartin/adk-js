/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The interfaces are erased at build time, so they must leave through
// `export type`. A value re-export of an erased name makes the built ESM
// module fail to load.
export {RestAgentIdentityCredentialsClient} from './agent_identity_credentials_client.js';
export type {
  AgentIdentityCredentialsClient,
  RetrieveCredentialsRequest,
  RetrieveCredentialsResponse,
  RetrieveCredentialsSuccess,
  UriConsentRequired,
} from './agent_identity_credentials_client.js';
export {AgentIdentityCredentialsProvider} from './agent_identity_credentials_provider.js';
export type {
  AgentIdentityCredentialsProviderOptions,
  CredentialsProvider,
} from './agent_identity_credentials_provider.js';
export {
  CredentialsResourceNoun,
  CredentialsServiceName,
  constructAuthCredential,
  isConsentCompleted,
} from './credentials_utils.js';
export type {HeaderCredentials} from './credentials_utils.js';
export {
  GCP_AUTH_PROVIDER_SCHEME_TYPE,
  GcpAuthProvider,
  isGcpAuthProviderScheme,
} from './gcp_auth_provider.js';
export type {GcpAuthProviderOptions} from './gcp_auth_provider.js';
export {RestIamConnectorCredentialsClient} from './iam_connector_credentials_client.js';
export type {
  ConnectorUriConsentRequired,
  IamConnectorCredentialsClient,
  RetrieveConnectorCredentialsRequest,
  RetrieveCredentialsMetadata,
  RetrieveCredentialsOperation,
  RetrieveCredentialsResult,
} from './iam_connector_credentials_client.js';
export {IamConnectorCredentialsProvider} from './iam_connector_credentials_provider.js';
export type {IamConnectorCredentialsProviderOptions} from './iam_connector_credentials_provider.js';
