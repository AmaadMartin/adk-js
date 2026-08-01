/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BaseTool,
  Context,
  createSession,
  GoogleApiTool,
  GoogleApiToolset,
  googleOidcAuthScheme,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  RestApiTool,
  ServiceAccount,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';

const CALENDAR_TOOL_NAMES = [
  'calendar.calendars.get',
  'calendar.calendars.insert',
  'calendar.events.list',
];

const SERVICE_ACCOUNT: ServiceAccount = {
  useDefaultCredential: true,
  scopes: ['https://www.googleapis.com/auth/calendar'],
};

/**
 * The session state key `ToolAuthHandler` reads an already-exchanged
 * OpenID Connect credential from.
 */
const EXCHANGED_CREDENTIAL_STATE_KEY =
  'openIdConnect_existing_exchanged_credential';

function createInvocationContext(
  state: Record<string, unknown> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events: [],
      state,
    }),
    pluginManager: new PluginManager(),
  });
}

/** Builds a real ReadonlyContext for the predicate-filter cases. */
function createReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(createInvocationContext());
}

/** Builds a tool context carrying an already-exchanged bearer credential. */
function createAuthenticatedToolContext(): Context {
  const credential: AuthCredential = {
    authType: AuthCredentialTypes.HTTP,
    http: {scheme: 'bearer', credentials: {token: 'test-access-token'}},
  };
  return new Context({
    invocationContext: createInvocationContext({
      [EXCHANGED_CREDENTIAL_STATE_KEY]: credential,
    }),
  });
}

describe('googleOidcAuthScheme', () => {
  const specWithScopes: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: {title: 'test', version: 'v1'},
    paths: {},
    components: {
      securitySchemes: {
        oauth2: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              scopes: {first: 'first scope', second: 'second scope'},
            },
          },
        },
      },
    },
  };

  it('describes the Google OpenID Connect endpoints', () => {
    expect(googleOidcAuthScheme(specWithScopes)).toEqual({
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
      scopes: ['first'],
    });
  });

  it('appends the additional scopes and de-duplicates in order', () => {
    expect(
      googleOidcAuthScheme(specWithScopes, ['extra', 'first', 'extra']).scopes,
    ).toEqual(['first', 'extra']);
  });

  it('falls back to the additional scopes with no oauth2 scheme', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'test', version: 'v1'},
      paths: {},
      components: {
        securitySchemes: {apiKey: {type: 'apiKey', in: 'query', name: 'key'}},
      },
    };

    expect(googleOidcAuthScheme(spec, ['extra']).scopes).toEqual(['extra']);
  });

  it('yields no scopes for a spec with no components at all', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'test', version: 'v1'},
      paths: {},
    };

    expect(googleOidcAuthScheme(spec).scopes).toEqual([]);
  });

  it('yields no scopes for an oauth2 scheme with no authorization code flow', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'test', version: 'v1'},
      paths: {},
      components: {securitySchemes: {oauth2: {type: 'oauth2', flows: {}}}},
    };

    expect(googleOidcAuthScheme(spec).scopes).toEqual([]);
  });
});

describe('GoogleApiToolset', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CALENDAR_DISCOVERY_DOCUMENT,
    });
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createToolset(
    options: Partial<ConstructorParameters<typeof GoogleApiToolset>[0]> = {},
  ): GoogleApiToolset {
    return new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      ...options,
    });
  }

  it('exposes one GoogleApiTool per discovery operation', async () => {
    const tools = await createToolset().getTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(CALENDAR_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool).toBeInstanceOf(GoogleApiTool);
    }
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
      expect.anything(),
    );
  });

  it('fetches the discovery document once across repeated calls', async () => {
    const toolset = createToolset();

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.map((tool) => tool.name)).toEqual(
      first.map((tool) => tool.name),
    );
  });

  it('fetches the discovery document once for concurrent calls', async () => {
    const toolset = createToolset();

    await Promise.all([toolset.getTools(), toolset.getTools()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards a custom discovery URL', async () => {
    await createToolset({
      discoveryUrl: 'https://private.example.com/{api}/{apiVersion}/rest',
    }).getTools();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://private.example.com/calendar/v3/rest',
      expect.anything(),
    );
  });

  it('applies a string filter with and without a context', async () => {
    const toolset = createToolset({toolFilter: ['calendar.events.list']});

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'calendar.events.list',
    ]);
    expect(
      (await toolset.getTools(createReadonlyContext())).map(
        (tool) => tool.name,
      ),
    ).toEqual(['calendar.events.list']);
  });

  it('applies a predicate filter when a context is available', async () => {
    const toolset = createToolset({
      toolFilter: (tool: BaseTool) => tool.name.endsWith('.get'),
    });

    const tools = await toolset.getTools(createReadonlyContext());

    expect(tools.map((tool) => tool.name)).toEqual(['calendar.calendars.get']);
  });

  it('skips a predicate filter when no context is available', async () => {
    const predicate = vi.fn().mockReturnValue(false);
    const toolset = createToolset({toolFilter: predicate});

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(CALENDAR_TOOL_NAMES);
    expect(predicate).not.toHaveBeenCalled();
  });

  it('prefixes every tool name, and filters on the prefixed name', async () => {
    const prefixed = await createToolset({prefix: 'cal'}).getTools();
    expect(prefixed.map((tool) => tool.name).sort()).toEqual(
      CALENDAR_TOOL_NAMES.map((name) => `cal_${name}`),
    );

    const filtered = await createToolset({
      prefix: 'cal',
      toolFilter: ['cal_calendar.events.list'],
    }).getTools();
    expect(filtered.map((tool) => tool.name)).toEqual([
      'cal_calendar.events.list',
    ]);
  });

  it('honours a filter installed after construction', async () => {
    const toolset = createToolset();
    expect(await toolset.getTools()).toHaveLength(3);

    toolset.setToolFilter(['calendar.calendars.insert']);

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'calendar.calendars.insert',
    ]);
  });

  it('passes the constructor credentials to every tool', async () => {
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );

    await createToolset({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }).getTools();

    expect(configureAuthCredential).toHaveBeenCalledTimes(3);
    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: 'openIdConnect',
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    });
  });

  it('passes credentials configured after construction to every tool', async () => {
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );
    const toolset = createToolset();

    await toolset.getTools();
    expect(configureAuthCredential).not.toHaveBeenCalled();

    toolset.configureAuth('late-id', 'late-secret');
    await toolset.getTools();
    expect(configureAuthCredential).toHaveBeenLastCalledWith({
      authType: 'openIdConnect',
      oauth2: {clientId: 'late-id', clientSecret: 'late-secret'},
    });

    toolset.configureSaAuth(SERVICE_ACCOUNT);
    await toolset.getTools();
    expect(configureAuthCredential).toHaveBeenLastCalledWith({
      authType: 'serviceAccount',
      serviceAccount: SERVICE_ACCOUNT,
    });
  });

  it('sends the additional headers on the outbound request', async () => {
    const tools = await createToolset({
      additionalHeaders: {'x-goog-user-project': 'my-project'},
    }).getTools();
    const tool = tools.find((t) => t.name === 'calendar.calendars.get');
    if (!tool) {
      return expect.fail('expected the calendars.get tool');
    }

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'application/json'},
      json: async () => ({id: 'primary'}),
    });
    const result = await tool.runAsync({
      args: {calendar_id: 'primary'},
      toolContext: createAuthenticatedToolContext(),
    });

    expect(result).toEqual({id: 'primary'});
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/calendars/primary'),
      expect.objectContaining({
        headers: {
          'Authorization': 'Bearer test-access-token',
          'x-goog-user-project': 'my-project',
        },
      }),
    );
  });

  it('closes cleanly before, after and twice over a getTools call', async () => {
    const neverLoaded = createToolset();
    await expect(neverLoaded.close()).resolves.toBeUndefined();

    const toolset = createToolset();
    await toolset.getTools();
    await expect(toolset.close()).resolves.toBeUndefined();
    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('closes cleanly after a failed discovery fetch', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const toolset = createToolset();

    await expect(toolset.getTools()).rejects.toThrow('HTTP 503');
    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
