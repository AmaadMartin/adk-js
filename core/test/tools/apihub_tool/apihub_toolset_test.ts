/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APIHubToolset,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  BaseAPIHubClient,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  RestApiTool,
} from '@google/adk';
import {YAMLException} from 'js-yaml';
import {Buffer} from 'node:buffer';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

const RESOURCE_NAME = 'test_resource';

const MOCK_SPEC = `
openapi: 3.0.0
info:
  version: 1.0.0
  title: Mock API
  description: Mock API Description
paths:
  /test:
    get:
      summary: Test GET endpoint
      operationId: testGet
      responses:
        '200':
          description: Successful response
`;

const SPEC_WITHOUT_TITLE = `
openapi: 3.0.0
info:
  version: 1.0.0
paths:
  /empty_desc_test:
    delete:
      summary: Test DELETE endpoint
      operationId: emptyDescTest
      responses:
        '200':
          description: Successful response
`;

const SPEC_WITHOUT_DESCRIPTION = `
openapi: 3.0.0
info:
  version: 1.0.0
  title: Empty Description API
paths:
  /empty_desc_test:
    delete:
      summary: Test DELETE endpoint
      operationId: emptyDescTest
      responses:
        '200':
          description: Successful response
`;

const AUTH_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: {read: 'Read access'},
    },
  },
};

const AUTH_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
  },
};

/** An API Hub client that serves a fixed spec and counts its calls. */
class FakeAPIHubClient implements BaseAPIHubClient {
  calls = 0;

  constructor(private readonly spec: string) {}

  async getSpecContent(_resourceName: string): Promise<string> {
    this.calls++;
    return this.spec;
  }
}

function createContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
  );
}

describe('APIHubToolset', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should fetch the spec during construction by default', async () => {
    const client = new FakeAPIHubClient(MOCK_SPEC);

    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: client,
    });

    expect(client.calls).toBe(1);
    await toolset.getTools();
  });

  it('should defer the fetch to getTools when lazyLoadSpec is set', async () => {
    const client = new FakeAPIHubClient(MOCK_SPEC);

    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: client,
      lazyLoadSpec: true,
    });

    expect(client.calls).toBe(0);
    await toolset.getTools();
    expect(client.calls).toBe(1);
  });

  it.each([[false], [true]])(
    'should fetch the spec at most once (lazyLoadSpec: %s)',
    async (lazyLoadSpec) => {
      const client = new FakeAPIHubClient(MOCK_SPEC);
      const toolset = new APIHubToolset({
        apihubResourceName: RESOURCE_NAME,
        apihubClient: client,
        lazyLoadSpec,
      });

      await toolset.getTools();
      await toolset.getTools();

      expect(client.calls).toBe(1);
    },
  );

  it('should generate one tool per spec operation', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(MOCK_SPEC),
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['test_get']);
  });

  it('should default the name and description to the spec info', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(MOCK_SPEC),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('mock_api');
    expect(toolset.description).toBe('Mock API Description');
  });

  it('should keep an explicit name and description', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(MOCK_SPEC),
      name: 'custom',
      description: 'custom desc',
    });

    await toolset.getTools();

    expect(toolset.name).toBe('custom');
    expect(toolset.description).toBe('custom desc');
  });

  it('should fall back to "unnamed" when the spec has no title', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(SPEC_WITHOUT_TITLE),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('unnamed');
  });

  it('should leave the description empty when the spec has none', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(SPEC_WITHOUT_DESCRIPTION),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('empty_description_api');
    expect(toolset.description).toBe('');
  });

  it('should return no tools for an empty spec', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(''),
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).resolves.toEqual([]);
  });

  it('should surface a YAML parse failure from getTools', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient('{invalid yaml'),
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).rejects.toThrow(YAMLException);
  });

  it('should not emit an unhandled rejection when the eager load fails', async () => {
    const onUnhandledRejection = vi.fn();
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const toolset = new APIHubToolset({
        apihubResourceName: RESOURCE_NAME,
        apihubClient: new FakeAPIHubClient('{invalid yaml'),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onUnhandledRejection).not.toHaveBeenCalled();
      await expect(toolset.getTools()).rejects.toThrow(YAMLException);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it.each([
    [['test_get'], ['test_get']],
    [['nonexistent'], []],
  ])('should apply the %o tool name filter', async (toolFilter, expected) => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(MOCK_SPEC),
      toolFilter,
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(expected);
  });

  it.each([
    [true, ['test_get']],
    [false, []],
  ])('should apply a tool predicate returning %s', async (keep, expected) => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(MOCK_SPEC),
      toolFilter: () => keep,
    });

    const tools = await toolset.getTools(createContext());

    expect(tools.map((tool) => tool.name)).toEqual(expected);
  });

  it('should apply the auth scheme and credential to every tool', async () => {
    const configureAuthScheme = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthScheme',
    );
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );

    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(MOCK_SPEC),
      authScheme: AUTH_SCHEME,
      authCredential: AUTH_CREDENTIAL,
    });

    expect(await toolset.getTools()).toHaveLength(1);
    expect(configureAuthScheme).toHaveBeenCalledWith(AUTH_SCHEME);
    expect(configureAuthCredential).toHaveBeenCalledWith(AUTH_CREDENTIAL);
  });

  it('should build an APIHubClient when none is injected', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            contents: Buffer.from(MOCK_SPEC).toString('base64'),
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        ),
      ),
    );

    const toolset = new APIHubToolset({
      apihubResourceName:
        'projects/p/locations/us-central1/apis/a/versions/v/specs/s',
      accessToken: 'mocked_token',
      lazyLoadSpec: true,
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['test_get']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://apihub.googleapis.com/v1/projects/p/locations/us-central1/apis/a/versions/v/specs/s:contents',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer mocked_token',
        }),
      }),
    );
  });

  it('should not touch the network when a client is injected', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(MOCK_SPEC),
    });

    await toolset.getTools();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a loaded spec', MOCK_SPEC],
    ['an empty spec', ''],
  ])('should close cleanly after %s', async (_name, spec) => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FakeAPIHubClient(spec),
    });

    await toolset.getTools();

    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
