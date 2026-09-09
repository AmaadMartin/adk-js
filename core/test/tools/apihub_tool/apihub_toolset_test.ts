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
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

const NO_TITLE_SPEC = `
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

const NO_DESCRIPTION_SPEC = `
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

const SERVED_SPEC = `
openapi: 3.0.0
info:
  version: 1.0.0
  title: Mock API
  description: Mock API Description
servers:
  - url: https://api.example.com
paths:
  /test:
    get:
      summary: Test GET endpoint
      operationId: testGet
      responses:
        '200':
          description: Successful response
`;

/** Serves a fixed spec and counts how often the toolset asks for it. */
class MockAPIHubClient implements BaseAPIHubClient {
  callCount = 0;

  constructor(private readonly spec: string = MOCK_SPEC) {}

  async getSpecContent(_resourceName: string): Promise<string> {
    this.callCount++;
    return this.spec;
  }
}

/** Fails every fetch, so the toolset always sees a rejected preparation. */
class FailingAPIHubClient implements BaseAPIHubClient {
  callCount = 0;

  async getSpecContent(_resourceName: string): Promise<string> {
    this.callCount++;
    throw new Error('api hub is down');
  }
}

function makeToolset(
  client: BaseAPIHubClient,
  options: {lazyLoadSpec?: boolean} = {},
): APIHubToolset {
  return new APIHubToolset({
    apihubResourceName: 'test_resource',
    apihubClient: client,
    ...options,
  });
}

function makeReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(makeInvocationContext());
}

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({id: 'session-1', appName: 'app'}),
    pluginManager: new PluginManager(),
  });
}

describe('APIHubToolset', () => {
  it('should generate one tool per operation in the spec', async () => {
    const toolset = makeToolset(new MockAPIHubClient());

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_get');
  });

  it('should name itself from the spec once prepared', async () => {
    const toolset = makeToolset(new MockAPIHubClient());

    await toolset.getTools();

    expect(toolset.name).toBe('mock_api');
    expect(toolset.description).toBe('Mock API Description');
  });

  it('should fetch the spec at construction by default', () => {
    const client = new MockAPIHubClient();

    makeToolset(client);

    expect(client.callCount).toBe(1);
  });

  it('should not fetch the spec at construction when lazy', () => {
    const client = new MockAPIHubClient();

    makeToolset(client, {lazyLoadSpec: true});

    expect(client.callCount).toBe(0);
  });

  it('should fetch the spec once for repeated lazy calls', async () => {
    const client = new MockAPIHubClient();
    const toolset = makeToolset(client, {lazyLoadSpec: true});

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(client.callCount).toBe(1);
  });

  it('should fetch the spec once for concurrent calls', async () => {
    const client = new MockAPIHubClient();
    const toolset = makeToolset(client, {lazyLoadSpec: true});

    const [first, second] = await Promise.all([
      toolset.getTools(),
      toolset.getTools(),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(client.callCount).toBe(1);
  });

  it('should name itself unnamed when the spec has no title', async () => {
    const toolset = makeToolset(new MockAPIHubClient(NO_TITLE_SPEC));

    await toolset.getTools();

    expect(toolset.name).toBe('unnamed');
  });

  it('should keep an empty description when the spec has none', async () => {
    const toolset = makeToolset(new MockAPIHubClient(NO_DESCRIPTION_SPEC));

    await toolset.getTools();

    expect(toolset.name).toBe('empty_description_api');
    expect(toolset.description).toBe('');
  });

  it('should keep the name and description given to the constructor', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(),
      name: 'my_toolset',
      description: 'My toolset',
    });

    await toolset.getTools();

    expect(toolset.name).toBe('my_toolset');
    expect(toolset.description).toBe('My toolset');
  });

  it('should expose no tool when the spec is empty', async () => {
    const toolset = makeToolset(new MockAPIHubClient(''));

    expect(await toolset.getTools()).toEqual([]);
    expect(toolset.name).toBe('');
  });

  it('should expose no tool when the spec is empty and lazy', async () => {
    const toolset = makeToolset(new MockAPIHubClient(''), {
      lazyLoadSpec: true,
    });

    expect(await toolset.getTools()).toEqual([]);
  });

  it('should expose no tool when the spec holds plain text', async () => {
    const toolset = makeToolset(new MockAPIHubClient('spec content'));

    expect(await toolset.getTools()).toEqual([]);
    expect(toolset.name).toBe('');
  });

  describe('tool filter', () => {
    it('should keep a tool the filter names', async () => {
      const toolset = new APIHubToolset({
        apihubResourceName: 'test_resource',
        apihubClient: new MockAPIHubClient(),
        toolFilter: ['test_get'],
      });

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['test_get']);
    });

    it('should drop a tool the filter does not name', async () => {
      const toolset = new APIHubToolset({
        apihubResourceName: 'test_resource',
        apihubClient: new MockAPIHubClient(),
        toolFilter: ['other'],
      });

      expect(await toolset.getTools()).toEqual([]);
    });

    it('should apply a predicate filter when a context is given', async () => {
      const toolset = new APIHubToolset({
        apihubResourceName: 'test_resource',
        apihubClient: new MockAPIHubClient(),
        toolFilter: (tool) => tool.name === 'other',
      });

      expect(await toolset.getTools(makeReadonlyContext())).toEqual([]);
    });

    it('should keep a tool a predicate filter accepts', async () => {
      const toolset = new APIHubToolset({
        apihubResourceName: 'test_resource',
        apihubClient: new MockAPIHubClient(),
        toolFilter: (tool) => tool.name === 'test_get',
      });

      const tools = await toolset.getTools(makeReadonlyContext());

      expect(tools.map((tool) => tool.name)).toEqual(['test_get']);
    });
  });

  describe('auth', () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      in: 'query',
      name: 'api_key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test-api-key',
    };

    const fetchMock = vi.fn<typeof fetch>();

    beforeEach(() => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ok: true}), {
          headers: {'content-type': 'application/json'},
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should pass the auth scheme and credential to the generated tool', async () => {
      const toolset = new APIHubToolset({
        apihubResourceName: 'test_resource',
        apihubClient: new MockAPIHubClient(SERVED_SPEC),
        authScheme,
        authCredential,
      });

      const tools = await toolset.getTools();
      expect(tools).toHaveLength(1);
      const result = await tools[0].runAsync({
        args: {},
        toolContext: new Context({
          invocationContext: makeInvocationContext(),
        }),
      });

      expect(result).toEqual({ok: true});
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.example.com/test?api_key=test-api-key',
      );
    });
  });

  describe('default client', () => {
    const fetchMock = vi.fn<typeof fetch>();

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should fetch the spec from API Hub with the given access token', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            contents: Buffer.from(MOCK_SPEC, 'utf-8').toString('base64'),
          }),
          {status: 200},
        ),
      );
      const toolset = new APIHubToolset({
        apihubResourceName:
          'projects/p/locations/us-central1/apis/a/versions/v1/specs/s1',
        accessToken: 'toolset_token',
      });

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['test_get']);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://apihub.googleapis.com/v1/projects/p/locations/us-central1/apis/a/versions/v1/specs/s1:contents',
      );
      expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
        'accept': 'application/json, text/plain, */*',
        'Authorization': 'Bearer toolset_token',
      });
    });
  });

  describe('failures', () => {
    it('should reject when the spec is not valid YAML', async () => {
      const toolset = makeToolset(new MockAPIHubClient('{invalid yaml'), {
        lazyLoadSpec: true,
      });

      await expect(toolset.getTools()).rejects.toThrow();
    });

    it('should reject with the error the client raised', async () => {
      const toolset = makeToolset(new FailingAPIHubClient(), {
        lazyLoadSpec: true,
      });

      await expect(toolset.getTools()).rejects.toThrow('api hub is down');
    });

    it('should fetch again after a failed preparation', async () => {
      const client = new FailingAPIHubClient();
      const toolset = makeToolset(client, {lazyLoadSpec: true});

      await expect(toolset.getTools()).rejects.toThrow('api hub is down');
      await expect(toolset.getTools()).rejects.toThrow('api hub is down');

      expect(client.callCount).toBe(2);
    });

    it('should not emit an unhandled rejection when the eager fetch fails', async () => {
      const rejections: unknown[] = [];
      const collect = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', collect);
      try {
        const toolset = makeToolset(new FailingAPIHubClient());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(rejections).toEqual([]);
        await expect(toolset.getTools()).rejects.toThrow('api hub is down');
      } finally {
        process.off('unhandledRejection', collect);
      }
    });
  });

  describe('close', () => {
    it('should resolve before any preparation', async () => {
      const toolset = makeToolset(new MockAPIHubClient(), {
        lazyLoadSpec: true,
      });

      await expect(toolset.close()).resolves.toBeUndefined();
    });

    it('should resolve twice after preparation', async () => {
      const toolset = makeToolset(new MockAPIHubClient());
      await toolset.getTools();

      await expect(toolset.close()).resolves.toBeUndefined();
      await expect(toolset.close()).resolves.toBeUndefined();
    });
  });
});
