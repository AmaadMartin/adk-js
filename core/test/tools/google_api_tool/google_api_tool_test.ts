/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  createSession,
  GoogleApiTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RestApiTool,
  ServiceAccount,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';

const SERVICE_ACCOUNT: ServiceAccount = {
  serviceAccountCredential: {
    type: 'service_account',
    projectId: 'project_id',
    privateKeyId: 'private_key_id',
    privateKey: 'private_key',
    clientEmail: 'client_email',
    clientId: 'client_id',
    authUri: 'auth_uri',
    tokenUri: 'token_uri',
    authProviderX509CertUrl: 'auth_provider_x509_cert_url',
    clientX509CertUrl: 'client_x509_cert_url',
    universeDomain: 'universe_domain',
  },
  scopes: ['scope1', 'scope2'],
};

/** Builds a real tool context, so no cast is needed to invoke a tool. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        events: [],
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

function createRestApiToolFixture(): RestApiTool {
  const operation: OpenAPIV3.OperationObject = {
    operationId: 'test_tool',
    responses: {},
  };
  return new RestApiTool(
    'test_tool',
    'Test Tool Description',
    {baseUrl: 'https://api.example.com', path: '/test', method: 'GET'},
    operation,
  );
}

describe('GoogleApiTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies the name, description and long-running flag', () => {
    const restApiTool = createRestApiToolFixture();

    const tool = new GoogleApiTool(restApiTool);

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('Test Tool Description');
    expect(tool.isLongRunning).toBe(false);
  });

  it('installs the additional headers on the wrapped tool', () => {
    const restApiTool = createRestApiToolFixture();
    const setDefaultHeaders = vi.spyOn(restApiTool, 'setDefaultHeaders');
    const headers = {'developer-token': 'test-token'};

    new GoogleApiTool(restApiTool, {additionalHeaders: headers});

    expect(setDefaultHeaders).toHaveBeenCalledTimes(1);
    expect(setDefaultHeaders).toHaveBeenCalledWith(headers);
  });

  it('leaves the default headers alone when none are supplied', () => {
    const restApiTool = createRestApiToolFixture();
    const setDefaultHeaders = vi.spyOn(restApiTool, 'setDefaultHeaders');

    new GoogleApiTool(restApiTool);

    expect(setDefaultHeaders).not.toHaveBeenCalled();
  });

  it('delegates the declaration to the wrapped tool', () => {
    const restApiTool = createRestApiToolFixture();
    const declaration: FunctionDeclaration = {
      name: 'test_function',
      description: 'Test function description',
    };
    const getDeclaration = vi
      .spyOn(restApiTool, '_getDeclaration')
      .mockReturnValue(declaration);

    const tool = new GoogleApiTool(restApiTool);

    expect(tool._getDeclaration()).toBe(declaration);
    expect(getDeclaration).toHaveBeenCalledTimes(1);
  });

  it('delegates runAsync to the wrapped tool', async () => {
    const restApiTool = createRestApiToolFixture();
    const runAsync = vi
      .spyOn(restApiTool, 'runAsync')
      .mockResolvedValue({result: 'success'});
    const tool = new GoogleApiTool(restApiTool);
    const request = {
      args: {param1: 'value1'},
      toolContext: createToolContext(),
    };

    const result = await tool.runAsync(request);

    expect(result).toEqual({result: 'success'});
    expect(runAsync).toHaveBeenCalledWith(request);
  });

  it('configures the OpenID Connect credential from a client id pair', () => {
    const restApiTool = createRestApiToolFixture();
    const configureAuthCredential = vi.spyOn(
      restApiTool,
      'configureAuthCredential',
    );

    new GoogleApiTool(restApiTool, {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });

    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
      },
    });
  });

  it('configures the bearer scheme and credential from a service account', () => {
    const restApiTool = createRestApiToolFixture();
    const configureAuthScheme = vi.spyOn(restApiTool, 'configureAuthScheme');
    const configureAuthCredential = vi.spyOn(
      restApiTool,
      'configureAuthCredential',
    );

    new GoogleApiTool(restApiTool, {serviceAccount: SERVICE_ACCOUNT});

    expect(configureAuthScheme).toHaveBeenCalledWith({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: SERVICE_ACCOUNT,
    });
  });

  it('prefers the service account over a client id pair', () => {
    const restApiTool = createRestApiToolFixture();
    const configureAuthCredential = vi.spyOn(
      restApiTool,
      'configureAuthCredential',
    );

    new GoogleApiTool(restApiTool, {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      serviceAccount: SERVICE_ACCOUNT,
    });

    expect(configureAuthCredential).toHaveBeenCalledTimes(1);
    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: SERVICE_ACCOUNT,
    });
  });

  it('configures nothing when only half of the client id pair is given', () => {
    const restApiTool = createRestApiToolFixture();
    const configureAuthCredential = vi.spyOn(
      restApiTool,
      'configureAuthCredential',
    );
    const configureAuthScheme = vi.spyOn(restApiTool, 'configureAuthScheme');

    new GoogleApiTool(restApiTool, {clientId: 'test_client_id'});
    new GoogleApiTool(restApiTool, {clientSecret: 'test_client_secret'});

    expect(configureAuthCredential).not.toHaveBeenCalled();
    expect(configureAuthScheme).not.toHaveBeenCalled();
  });

  it('applies credentials configured after construction', () => {
    const restApiTool = createRestApiToolFixture();
    const configureAuthCredential = vi.spyOn(
      restApiTool,
      'configureAuthCredential',
    );
    const tool = new GoogleApiTool(restApiTool);

    tool.configureAuth('late_id', 'late_secret');

    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {clientId: 'late_id', clientSecret: 'late_secret'},
    });

    tool.configureSaAuth(SERVICE_ACCOUNT);

    expect(configureAuthCredential).toHaveBeenLastCalledWith({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: SERVICE_ACCOUNT,
    });
  });
});
