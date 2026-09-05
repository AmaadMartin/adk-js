/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  Context,
  Event,
  GcpAuthProviderScheme,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {
  AgentIdentityCredentialsClient,
  RetrieveCredentialsRequest,
  RetrieveCredentialsResponse,
} from '../../../src/integrations/agent_identity/agent_identity_credentials_client.js';
import {
  IamConnectorCredentialsClient,
  RetrieveConnectorCredentialsRequest,
  RetrieveCredentialsMetadata,
  RetrieveCredentialsOperation,
} from '../../../src/integrations/agent_identity/iam_connector_credentials_client.js';

/** The auth provider resource name the ported tests use. */
export const AUTH_PROVIDER_NAME =
  'projects/test-project/locations/global/authProviders/test-provider';

/** The scheme the ported tests pass to the provider. */
export function createAuthScheme(
  overrides: Partial<GcpAuthProviderScheme> = {},
): GcpAuthProviderScheme {
  return {
    type: 'gcpAuthProviderScheme',
    name: AUTH_PROVIDER_NAME,
    scopes: ['test-scope'],
    continueUri: 'https://example.com/continue',
    ...overrides,
  };
}

/** Wraps a scheme in an `AuthConfig`. */
export function createAuthConfig(
  authScheme: GcpAuthProviderScheme,
): AuthConfig {
  return {authScheme, credentialKey: 'gcp-auth-provider'};
}

/** Builds a real `Context` over a real session. */
export function createContext(
  options: {
    userId?: string;
    functionCallId?: string;
    events?: Event[];
  } = {},
): Context {
  const session = createSession({
    id: 'session-1',
    appName: 'test-app',
    userId: options.userId ?? 'user',
    events: options.events ?? [],
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      session,
      pluginManager: new PluginManager(),
    }),
    functionCallId: options.functionCallId,
  });
}

/** A client that answers from a caller-supplied function and records calls. */
export class FakeCredentialsClient implements AgentIdentityCredentialsClient {
  readonly authProviders: string[] = [];
  readonly requests: RetrieveCredentialsRequest[] = [];

  constructor(
    public respond: (callIndex: number) => RetrieveCredentialsResponse,
  ) {}

  async retrieveCredentials(
    authProvider: string,
    request: RetrieveCredentialsRequest,
  ): Promise<RetrieveCredentialsResponse> {
    this.authProviders.push(authProvider);
    this.requests.push(request);
    return this.respond(this.requests.length - 1);
  }
}

/** A client that always fails, so the error path can be exercised. */
export class FailingCredentialsClient implements AgentIdentityCredentialsClient {
  constructor(private readonly error: Error) {}

  retrieveCredentials(): Promise<RetrieveCredentialsResponse> {
    return Promise.reject(this.error);
  }
}

/** A success response carrying a bearer token. */
export function bearerSuccess(
  token = 'test-token',
): RetrieveCredentialsResponse {
  return {success: {header: 'Authorization: Bearer', token}};
}

/** The connector resource name the ported connector tests use. */
export const CONNECTOR_NAME =
  'projects/test-project/locations/global/connectors/test-connector';

/** The scheme the ported connector tests pass to the provider. */
export function createConnectorScheme(
  overrides: Partial<GcpAuthProviderScheme> = {},
): GcpAuthProviderScheme {
  return createAuthScheme({name: CONNECTOR_NAME, ...overrides});
}

/** A connector client that answers from a caller-supplied function. */
export class FakeConnectorClient implements IamConnectorCredentialsClient {
  readonly connectors: string[] = [];
  readonly requests: RetrieveConnectorCredentialsRequest[] = [];

  constructor(
    public respond: (callIndex: number) => RetrieveCredentialsOperation,
  ) {}

  async retrieveCredentials(
    connector: string,
    request: RetrieveConnectorCredentialsRequest,
  ): Promise<RetrieveCredentialsOperation> {
    this.connectors.push(connector);
    this.requests.push(request);
    return this.respond(this.requests.length - 1);
  }
}

/** A connector client that always fails, so the error path can be exercised. */
export class FailingConnectorClient implements IamConnectorCredentialsClient {
  constructor(private readonly error: Error) {}

  retrieveCredentials(): Promise<RetrieveCredentialsOperation> {
    return Promise.reject(this.error);
  }
}

/** A completed operation carrying a bearer token. */
export function bearerOperation(
  token = 'test-token',
): RetrieveCredentialsOperation {
  return {done: true, response: {header: 'Authorization: Bearer', token}};
}

/** A running operation whose metadata reports the given status. */
export function pendingOperation(
  metadata: RetrieveCredentialsMetadata,
): RetrieveCredentialsOperation {
  return {done: false, metadata};
}
