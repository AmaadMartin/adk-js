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
  PluginManager,
  RestApiTool,
  ServiceAccount,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

function createRestApiToolDouble(): RestApiTool {
  return new RestApiTool(
    'test_tool',
    'Test Tool Description',
    {baseUrl: 'http://api.example.com', path: '/test', method: 'GET'},
    {responses: {}},
  );
}

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

describe('GoogleApiTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies name, description and isLongRunning from the wrapped tool', () => {
    const restApiTool = createRestApiToolDouble();

    const tool = new GoogleApiTool(restApiTool);

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('Test Tool Description');
    expect(tool.isLongRunning).toBe(restApiTool.isLongRunning);
    expect(tool.isLongRunning).toBe(false);
  });

  it('sets the additional headers as defaults on the wrapped tool', () => {
    const restApiTool = createRestApiToolDouble();
    const setDefaultHeaders = vi.spyOn(restApiTool, 'setDefaultHeaders');
    const headers = {'developer-token': 'test-token'};

    new GoogleApiTool(restApiTool, {additionalHeaders: headers});

    expect(setDefaultHeaders).toHaveBeenCalledTimes(1);
    expect(setDefaultHeaders).toHaveBeenCalledWith(headers);
  });

  it('does not set default headers when none are given', () => {
    const restApiTool = createRestApiToolDouble();
    const setDefaultHeaders = vi.spyOn(restApiTool, 'setDefaultHeaders');

    new GoogleApiTool(restApiTool);

    expect(setDefaultHeaders).not.toHaveBeenCalled();
  });

  it('does not set default headers when the given headers are empty', () => {
    const restApiTool = createRestApiToolDouble();
    const setDefaultHeaders = vi.spyOn(restApiTool, 'setDefaultHeaders');

    new GoogleApiTool(restApiTool, {additionalHeaders: {}});

    expect(setDefaultHeaders).not.toHaveBeenCalled();
  });

  it('returns the wrapped tool declaration', () => {
    const restApiTool = createRestApiToolDouble();
    const declaration = {
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

  it('forwards runAsync to the wrapped tool', async () => {
    const restApiTool = createRestApiToolDouble();
    const runAsync = vi
      .spyOn(restApiTool, 'runAsync')
      .mockResolvedValue({result: 'success'});
    const tool = new GoogleApiTool(restApiTool);
    const request = {
      args: {param1: 'value1'},
      toolContext: createToolContext(),
    };

    await expect(tool.runAsync(request)).resolves.toEqual({result: 'success'});
    expect(runAsync).toHaveBeenCalledTimes(1);
    expect(runAsync).toHaveBeenCalledWith(request);
  });

  describe('configureAuth', () => {
    it('configures an OpenID Connect credential', () => {
      const restApiTool = createRestApiToolDouble();
      const configureAuthCredential = vi.spyOn(
        restApiTool,
        'configureAuthCredential',
      );
      const tool = new GoogleApiTool(restApiTool);

      tool.configureAuth('test_client_id', 'test_client_secret');

      expect(configureAuthCredential).toHaveBeenCalledWith({
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {
          clientId: 'test_client_id',
          clientSecret: 'test_client_secret',
        },
      });
    });
  });

  describe('configureSaAuth', () => {
    it('configures a client-credentials scheme and a service account credential', () => {
      const restApiTool = createRestApiToolDouble();
      const configureAuthScheme = vi.spyOn(restApiTool, 'configureAuthScheme');
      const configureAuthCredential = vi.spyOn(
        restApiTool,
        'configureAuthCredential',
      );
      const tool = new GoogleApiTool(restApiTool);

      tool.configureSaAuth(SERVICE_ACCOUNT);

      expect(configureAuthScheme).toHaveBeenCalledWith({
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://oauth2.mtls.googleapis.com/token',
            scopes: {},
          },
        },
      });
      expect(configureAuthCredential).toHaveBeenCalledWith({
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: SERVICE_ACCOUNT,
      });
    });
  });

  describe('constructor credential selection', () => {
    it('configures the service account when only it is given', () => {
      const restApiTool = createRestApiToolDouble();
      const configureAuthScheme = vi.spyOn(restApiTool, 'configureAuthScheme');
      const configureAuthCredential = vi.spyOn(
        restApiTool,
        'configureAuthCredential',
      );

      new GoogleApiTool(restApiTool, {serviceAccount: SERVICE_ACCOUNT});

      expect(configureAuthScheme).toHaveBeenCalledTimes(1);
      expect(configureAuthCredential).toHaveBeenCalledWith({
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: SERVICE_ACCOUNT,
      });
    });

    it('configures OpenID Connect when the client id and secret are given', () => {
      const restApiTool = createRestApiToolDouble();
      const configureAuthScheme = vi.spyOn(restApiTool, 'configureAuthScheme');
      const configureAuthCredential = vi.spyOn(
        restApiTool,
        'configureAuthCredential',
      );

      new GoogleApiTool(restApiTool, {
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
      });

      expect(configureAuthScheme).not.toHaveBeenCalled();
      expect(configureAuthCredential).toHaveBeenCalledWith({
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {
          clientId: 'test_client_id',
          clientSecret: 'test_client_secret',
        },
      });
    });

    it('prefers the service account over the client id and secret', () => {
      const restApiTool = createRestApiToolDouble();
      const configureAuthCredential = vi.spyOn(
        restApiTool,
        'configureAuthCredential',
      );

      new GoogleApiTool(restApiTool, {
        serviceAccount: SERVICE_ACCOUNT,
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
      });

      expect(configureAuthCredential).toHaveBeenCalledTimes(1);
      expect(configureAuthCredential).toHaveBeenCalledWith({
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: SERVICE_ACCOUNT,
      });
    });

    it('configures nothing when only the client id is given', () => {
      const restApiTool = createRestApiToolDouble();
      const configureAuthCredential = vi.spyOn(
        restApiTool,
        'configureAuthCredential',
      );

      new GoogleApiTool(restApiTool, {clientId: 'test_client_id'});

      expect(configureAuthCredential).not.toHaveBeenCalled();
    });

    it('configures nothing when only the client secret is given', () => {
      const restApiTool = createRestApiToolDouble();
      const configureAuthCredential = vi.spyOn(
        restApiTool,
        'configureAuthCredential',
      );

      new GoogleApiTool(restApiTool, {clientSecret: 'test_client_secret'});

      expect(configureAuthCredential).not.toHaveBeenCalled();
    });

    it('configures nothing when no options are given', () => {
      const restApiTool = createRestApiToolDouble();
      const configureAuthScheme = vi.spyOn(restApiTool, 'configureAuthScheme');
      const configureAuthCredential = vi.spyOn(
        restApiTool,
        'configureAuthCredential',
      );

      new GoogleApiTool(restApiTool);

      expect(configureAuthScheme).not.toHaveBeenCalled();
      expect(configureAuthCredential).not.toHaveBeenCalled();
    });
  });
});
