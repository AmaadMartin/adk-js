/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  BaseTool,
  createSession,
  DiscoveryDocument,
  GoogleApiToolset,
  GoogleApiToolsetOptions,
  InvocationContext,
  OpenAPIToolset,
  PluginManager,
  ReadonlyContext,
  RestApiTool,
  ServiceAccount,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';
import {capturedRequest, respondWith} from './https_transport_fake.js';

const {requestMock, agentMock, clientCertsMock, dispatcherMock} = vi.hoisted(
  () => ({
    requestMock: vi.fn(),
    agentMock: vi.fn(),
    clientCertsMock: vi.fn(),
    dispatcherMock: vi.fn(),
  }),
);

vi.mock('node:https', () => ({request: requestMock, Agent: agentMock}));

vi.mock('../../../src/utils/mtls_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/utils/mtls_utils.js')>();
  return {
    ...actual,
    clientCertsToPresent: clientCertsMock,
    clientCertDispatcher: dispatcherMock,
  };
});

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const CALENDAR_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** The tool names the Calendar fixture produces, in document order. */
const CALENDAR_TOOL_NAMES = [
  'calendar_calendars_get',
  'calendar_calendars_insert',
  'calendar_events_list',
];

const SERVICE_ACCOUNT: ServiceAccount = {
  useDefaultCredential: true,
  scopes: [CALENDAR_SCOPE],
};

/** Serves `document` as the answer to every Discovery fetch. */
function serveDiscovery(document: DiscoveryDocument): void {
  respondWith(requestMock, {
    statusCode: 200,
    body: JSON.stringify(document),
  });
}

/** Returns a copy of `document` with its OAuth2 block removed. */
function withoutAuth(document: DiscoveryDocument): DiscoveryDocument {
  const copy = {...document};
  delete copy.auth;
  return copy;
}

function makeReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'session-1', appName: 'app'}),
      pluginManager: new PluginManager(),
    }),
  );
}

function makeToolset(
  options: Partial<GoogleApiToolsetOptions> = {},
): GoogleApiToolset {
  return new GoogleApiToolset({
    apiName: 'calendar',
    apiVersion: 'v3',
    ...options,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  requestMock.mockReset();
  clientCertsMock.mockReset();
  dispatcherMock.mockReset();
  clientCertsMock.mockResolvedValue(undefined);
  serveDiscovery(CALENDAR_DISCOVERY_DOCUMENT);
});

describe('GoogleApiToolset construction', () => {
  it('exposes the api it serves and one tool per discovery method', async () => {
    const toolset = makeToolset();

    expect(toolset.apiName).toBe('calendar');
    expect(toolset.apiVersion).toBe('v3');
    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual(
      CALENDAR_TOOL_NAMES,
    );
  });

  it('fetches the discovery document from the default endpoint', async () => {
    const toolset = makeToolset();
    await toolset.getTools();

    expect(capturedRequest(requestMock).url).toBe(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
  });

  it('fetches the discovery document from discoveryUrl when given', async () => {
    const toolset = makeToolset({
      discoveryUrl: 'https://example.com/discovery',
    });
    await toolset.getTools();

    expect(capturedRequest(requestMock).url).toBe(
      'https://example.com/discovery',
    );
  });

  it('fetches the discovery document once for repeated getTools calls', async () => {
    const toolset = makeToolset();
    await toolset.getTools();
    await toolset.getTools();

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does not raise an unhandled rejection when nothing calls getTools', async () => {
    respondWith(requestMock, {statusCode: 404, body: 'not found'});
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    try {
      const toolset = makeToolset();
      expect(toolset.apiName).toBe('calendar');
      // Node reports an unhandled rejection on a later macrotask tick.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    expect(rejections).toEqual([]);
  });
});

describe('GoogleApiToolset auth scheme', () => {
  /**
   * Returns the OpenID Connect scheme the toolset configured its generated
   * tools with.
   *
   * Each `RestApiTool` is also configured with the document's own `oauth2`
   * scheme by its constructor, so the calls are filtered by scheme type. The
   * toolset applies its scheme afterwards, and it wins.
   */
  async function configuredOidcScheme(
    toolset: GoogleApiToolset,
  ): Promise<unknown> {
    const spy = vi.spyOn(RestApiTool.prototype, 'configureAuthScheme');
    const tools = await toolset.getTools();
    const schemes = spy.mock.calls
      .map(([scheme]) => scheme)
      .filter(
        (scheme) =>
          typeof scheme === 'object' && scheme.type === 'openIdConnect',
      );
    if (schemes.length !== tools.length) {
      return expect.fail(
        `expected ${tools.length} openIdConnect schemes, got ${schemes.length}`,
      );
    }
    return schemes[0];
  }

  it('configures google openid connect endpoints on every tool', async () => {
    const scheme = await configuredOidcScheme(makeToolset());

    expect(scheme).toEqual({
      type: 'openIdConnect',
      openIdConnectUrl: '',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
      tokenEndpointAuthMethodsSupported: [
        'client_secret_post',
        'client_secret_basic',
      ],
      grantTypesSupported: ['authorization_code'],
      scopes: [CALENDAR_SCOPE],
    });
  });

  it('keeps the first discovery scope and drops a duplicate of it', async () => {
    const scheme = await configuredOidcScheme(
      makeToolset({
        additionalScopes: [CALENDAR_SCOPE, CALENDAR_READONLY_SCOPE],
      }),
    );

    expect(scheme).toEqual(
      expect.objectContaining({
        scopes: [CALENDAR_SCOPE, CALENDAR_READONLY_SCOPE],
      }),
    );
  });

  it('puts the default discovery scope ahead of an additional scope', async () => {
    const scheme = await configuredOidcScheme(
      makeToolset({additionalScopes: [DRIVE_SCOPE]}),
    );

    expect(scheme).toEqual(
      expect.objectContaining({scopes: [CALENDAR_SCOPE, DRIVE_SCOPE]}),
    );
  });

  it('requests no scope for a document that declares no oauth2 block', async () => {
    serveDiscovery(withoutAuth(CALENDAR_DISCOVERY_DOCUMENT));

    const scheme = await configuredOidcScheme(makeToolset());

    expect(scheme).toEqual(expect.objectContaining({scopes: []}));
  });
});

describe('GoogleApiToolset tool filtering', () => {
  it('returns every tool when no filter is set', async () => {
    const tools = await makeToolset().getTools();

    expect(tools).toHaveLength(CALENDAR_TOOL_NAMES.length);
  });

  it('returns every tool for an empty filter list', async () => {
    const tools = await makeToolset({toolFilter: []}).getTools();

    expect(tools).toHaveLength(CALENDAR_TOOL_NAMES.length);
  });

  it('returns only the tools a name list selects', async () => {
    const toolset = makeToolset({toolFilter: ['calendar_events_list']});

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'calendar_events_list',
    ]);
  });

  it('returns only the tools a predicate accepts, and passes it the context', async () => {
    const context = makeReadonlyContext();
    const seen: Array<ReadonlyContext | undefined> = [];
    const toolset = makeToolset({
      toolFilter: (tool: BaseTool, readonlyContext?: ReadonlyContext) => {
        seen.push(readonlyContext);
        return tool.name.endsWith('_insert');
      },
    });

    const tools = await toolset.getTools(context);

    expect(tools.map((tool) => tool.name)).toEqual([
      'calendar_calendars_insert',
    ]);
    expect(seen).toEqual([context, context, context]);
  });

  it('applies a name list set after construction on the next getTools call', async () => {
    const toolset = makeToolset();
    expect(await toolset.getTools()).toHaveLength(CALENDAR_TOOL_NAMES.length);

    toolset.setToolFilter(['calendar_calendars_get']);

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'calendar_calendars_get',
    ]);
  });

  it('applies a predicate set after construction on the next getTools call', async () => {
    const toolset = makeToolset({toolFilter: ['calendar_calendars_get']});

    toolset.setToolFilter((tool: BaseTool) => tool.name.endsWith('_list'));

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'calendar_events_list',
    ]);
  });

  it('prefixes every tool name with toolNamePrefix', async () => {
    const toolset = makeToolset({toolNamePrefix: 'test_prefix'});

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual(
      CALENDAR_TOOL_NAMES.map((name) => `test_prefix_${name}`),
    );
  });
});

describe('GoogleApiToolset credentials', () => {
  it('gives every returned tool the additional headers', async () => {
    const headers = {'developer-token': 'test-token'};
    const spy = vi.spyOn(RestApiTool.prototype, 'setDefaultHeaders');
    const toolset = makeToolset({additionalHeaders: headers});

    const tools = await toolset.getTools();

    expect(spy).toHaveBeenCalledTimes(tools.length);
    expect(spy).toHaveBeenCalledWith(headers);
  });

  it('never credentials a tool the filter rejected', async () => {
    const spy = vi.spyOn(RestApiTool.prototype, 'setDefaultHeaders');
    const toolset = makeToolset({
      additionalHeaders: {'developer-token': 'test-token'},
      toolFilter: ['calendar_events_list'],
    });

    await toolset.getTools();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives every returned tool the openid connect client credential', async () => {
    const spy = vi.spyOn(RestApiTool.prototype, 'configureAuthCredential');
    const toolset = makeToolset({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    });

    const tools = await toolset.getTools();

    expect(spy).toHaveBeenCalledTimes(tools.length);
    expect(spy).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      },
    });
  });

  it('prefers the service account over the client id and secret', async () => {
    const schemeSpy = vi.spyOn(RestApiTool.prototype, 'configureAuthScheme');
    const credentialSpy = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );
    const toolset = makeToolset({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      serviceAccount: SERVICE_ACCOUNT,
    });

    await toolset.getTools();

    expect(credentialSpy).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: SERVICE_ACCOUNT,
    });
    expect(credentialSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({authType: AuthCredentialTypes.OPEN_ID_CONNECT}),
    );
    expect(schemeSpy).toHaveBeenCalledWith(
      expect.objectContaining({type: 'oauth2'}),
    );
  });

  it('builds the next tools with the client credential configureAuth set', async () => {
    const spy = vi.spyOn(RestApiTool.prototype, 'configureAuthCredential');
    const toolset = makeToolset();
    await toolset.getTools();
    expect(spy).not.toHaveBeenCalled();

    toolset.configureAuth('late-client-id', 'late-client-secret');
    await toolset.getTools();

    expect(spy).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: 'late-client-id',
        clientSecret: 'late-client-secret',
      },
    });
  });

  it('builds the next tools with the service account configureSaAuth set', async () => {
    const spy = vi.spyOn(RestApiTool.prototype, 'configureAuthCredential');
    const toolset = makeToolset();
    await toolset.getTools();
    expect(spy).not.toHaveBeenCalled();

    toolset.configureSaAuth(SERVICE_ACCOUNT);
    await toolset.getTools();

    expect(spy).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: SERVICE_ACCOUNT,
    });
  });
});

describe('GoogleApiToolset client certificate', () => {
  it('dispatches tool requests through the client certificate when there is one', async () => {
    const certs = {cert: 'test-cert', key: 'test-key'};
    clientCertsMock.mockResolvedValue(certs);
    dispatcherMock.mockResolvedValue({dispatch: () => true});

    await makeToolset().getTools();

    expect(dispatcherMock).toHaveBeenCalledWith(certs);
  });

  it('builds no dispatcher when there is no client certificate', async () => {
    await makeToolset().getTools();

    expect(dispatcherMock).not.toHaveBeenCalled();
  });
});

describe('GoogleApiToolset failure and shutdown', () => {
  it('reports the discovery failure and fetches again on the next call', async () => {
    respondWith(requestMock, {statusCode: 404, body: 'not found'});
    const toolset = makeToolset();

    await expect(toolset.getTools()).rejects.toThrow(
      'Failed to fetch the discovery document for calendar v3 from ' +
        'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest: ' +
        'HTTP 404',
    );

    serveDiscovery(CALENDAR_DISCOVERY_DOCUMENT);
    expect(await toolset.getTools()).toHaveLength(CALENDAR_TOOL_NAMES.length);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('closes the inner openapi toolset', async () => {
    const spy = vi.spyOn(OpenAPIToolset.prototype, 'close');
    const toolset = makeToolset();
    await toolset.getTools();

    await toolset.close();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('closes without an inner toolset when the discovery fetch failed', async () => {
    respondWith(requestMock, {statusCode: 500, body: 'boom'});
    const toolset = makeToolset();
    await expect(toolset.getTools()).rejects.toThrow('HTTP 500');

    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
