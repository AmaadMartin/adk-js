/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  BaseTool,
  convertDiscoveryDocument,
  createSession,
  GoogleApiTool,
  GoogleApiToolset,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  RestApiTool,
  ServiceAccount,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
// Not re-exported from the package root: the scheme builder is an
// implementation detail of the toolset, matching adk-python's private
// `_load_toolset_with_oidc_auth`.
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {googleOidcAuthScheme} from '../../../src/tools/google_api_tool/google_api_toolset.js';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';
import {capturedRequest, respondWith} from './https_transport_fake.js';

const {requestMock} = vi.hoisted(() => ({requestMock: vi.fn()}));
vi.mock('node:https', () => ({request: requestMock, Agent: vi.fn()}));

/** The tool names the calendar fixture converts to, in order. */
const CALENDAR_TOOL_NAMES = [
  'calendar.calendars.get',
  'calendar.calendars.insert',
  'calendar.events.list',
];

const SERVICE_ACCOUNT: ServiceAccount = {useDefaultCredential: true};

function serveCalendarDocument(): void {
  respondWith(requestMock, {
    statusCode: 200,
    body: JSON.stringify(CALENDAR_DISCOVERY_DOCUMENT),
  });
}

function createReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  );
}

describe('GoogleApiToolset', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    requestMock.mockReset();
    serveCalendarDocument();
  });

  it('exposes its api name and version without fetching anything', () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    expect(toolset.apiName).toBe('calendar');
    expect(toolset.apiVersion).toBe('v3');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('returns one GoogleApiTool per converted operation', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(CALENDAR_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool).toBeInstanceOf(GoogleApiTool);
    }
  });

  it('fetches the discovery document once across repeated calls', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    await toolset.getTools();
    await toolset.getTools();

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('fetches the discovery document once across concurrent calls', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    await Promise.all([toolset.getTools(), toolset.getTools()]);

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('requests the default discovery url for the api and version', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    await toolset.getTools();

    expect(capturedRequest(requestMock).url).toBe(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
  });

  it('requests the discoveryUrl override instead', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      discoveryUrl: 'https://discovery.example/{api}/{apiVersion}.json',
    });

    await toolset.getTools();

    expect(capturedRequest(requestMock).url).toBe(
      'https://discovery.example/calendar/v3.json',
    );
  });

  it('returns only the tools a name-list filter names', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      toolFilter: ['calendar.events.list'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['calendar.events.list']);
  });

  it('applies a predicate filter and passes it the tool and context', async () => {
    const context = createReadonlyContext();
    const predicate = vi.fn(
      (tool: BaseTool) => tool.name === 'calendar.calendars.get',
    );
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      toolFilter: predicate,
    });

    const tools = await toolset.getTools(context);

    expect(tools.map((tool) => tool.name)).toEqual(['calendar.calendars.get']);
    expect(predicate).toHaveBeenCalledWith(
      expect.objectContaining({name: 'calendar.events.list'}),
      context,
    );
  });

  it('applies a filter set after the first getTools call', async () => {
    // The first filter selects a different tool from the second, so a filter
    // delegated to the inner toolset at build time would narrow the second
    // call to nothing.
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      toolFilter: ['calendar.calendars.get'],
    });
    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'calendar.calendars.get',
    ]);

    toolset.setToolFilter(['calendar.calendars.insert']);

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'calendar.calendars.insert',
    ]);
  });

  it('prefixes every tool name with toolNamePrefix', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      toolNamePrefix: 'gcal',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(
      CALENDAR_TOOL_NAMES.map((name) => `gcal_${name}`),
    );
  });

  it('passes additionalHeaders to every wrapped tool', async () => {
    const setDefaultHeaders = vi.spyOn(
      RestApiTool.prototype,
      'setDefaultHeaders',
    );
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      additionalHeaders: {'developer-token': 'token-value'},
    });

    await toolset.getTools();

    expect(setDefaultHeaders).toHaveBeenCalledTimes(CALENDAR_TOOL_NAMES.length);
    expect(setDefaultHeaders).toHaveBeenCalledWith({
      'developer-token': 'token-value',
    });
  });

  it('configures an OpenID Connect credential from the client id pair', async () => {
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    await toolset.getTools();

    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    });
  });

  it('configures the service account scheme and credential', async () => {
    const configureAuthScheme = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthScheme',
    );
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      serviceAccount: SERVICE_ACCOUNT,
    });

    await toolset.getTools();

    expect(configureAuthScheme).toHaveBeenCalledWith(
      expect.objectContaining({type: 'oauth2'}),
    );
    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: SERVICE_ACCOUNT,
    });
  });

  it('applies configureAuth to the tools of the next getTools call', async () => {
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });
    await toolset.getTools();
    expect(configureAuthCredential).not.toHaveBeenCalled();

    toolset.configureAuth('later-id', 'later-secret');
    await toolset.getTools();

    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {clientId: 'later-id', clientSecret: 'later-secret'},
    });
  });

  it('applies configureSaAuth to the tools of the next getTools call', async () => {
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });
    await toolset.getTools();
    expect(configureAuthCredential).not.toHaveBeenCalled();

    toolset.configureSaAuth(SERVICE_ACCOUNT);
    await toolset.getTools();

    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: SERVICE_ACCOUNT,
    });
  });

  it('closes an unused toolset without fetching anything', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    await expect(toolset.close()).resolves.toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('closes a used toolset', async () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });
    await toolset.getTools();

    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('rejects on a failed discovery fetch and retries on the next call', async () => {
    respondWith(requestMock, {statusCode: 500, body: 'server error'});
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    await expect(toolset.getTools()).rejects.toThrow(/calendar v3/);

    serveCalendarDocument();
    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual(
      CALENDAR_TOOL_NAMES,
    );
  });

  it('closes without rejecting after a failed load', async () => {
    respondWith(requestMock, {statusCode: 500, body: 'server error'});
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });
    await expect(toolset.getTools()).rejects.toThrow();

    await expect(toolset.close()).resolves.toBeUndefined();
  });
});

describe('googleOidcAuthScheme', () => {
  const calendarSpec = convertDiscoveryDocument(
    CALENDAR_DISCOVERY_DOCUMENT,
    'calendar',
    'v3',
  );

  it('keeps only the first discovery scope', () => {
    expect(googleOidcAuthScheme(calendarSpec).scopes).toEqual([
      'https://www.googleapis.com/auth/calendar',
    ]);
  });

  it('appends the additional scopes and de-duplicates them', () => {
    const scheme = googleOidcAuthScheme(calendarSpec, [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/calendar',
    ]);

    expect(scheme.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
    ]);
  });

  it('falls back to the additional scopes when the spec declares no oauth2', () => {
    const spec = convertDiscoveryDocument(
      {...CALENDAR_DISCOVERY_DOCUMENT, auth: undefined},
      'calendar',
      'v3',
    );

    expect(googleOidcAuthScheme(spec).scopes).toEqual([]);
    expect(googleOidcAuthScheme(spec, ['scope-a']).scopes).toEqual(['scope-a']);
  });

  it('reads no discovery scope from a scheme that declares none', () => {
    const base: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'test', version: 'v1'},
      paths: {},
    };
    const withoutComponents = googleOidcAuthScheme(base, ['scope-a']);
    const withReference = googleOidcAuthScheme(
      {
        ...base,
        components: {securitySchemes: {oauth2: {$ref: '#/x/oauth2'}}},
      },
      ['scope-a'],
    );
    const withoutAuthorizationCode = googleOidcAuthScheme(
      {
        ...base,
        components: {securitySchemes: {oauth2: {type: 'oauth2', flows: {}}}},
      },
      ['scope-a'],
    );

    expect(withoutComponents.scopes).toEqual(['scope-a']);
    expect(withReference.scopes).toEqual(['scope-a']);
    expect(withoutAuthorizationCode.scopes).toEqual(['scope-a']);
  });

  it('declares the Google OpenID Connect endpoints', () => {
    expect(googleOidcAuthScheme(calendarSpec)).toMatchObject({
      type: 'openIdConnect',
      openIdConnectUrl:
        'https://accounts.google.com/.well-known/openid-configuration',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
      tokenEndpointAuthMethodsSupported: [
        'client_secret_post',
        'client_secret_basic',
      ],
      grantTypesSupported: ['authorization_code'],
    });
  });
});
