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
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

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

const EMPTY_DESCRIPTION_SPEC = `
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

const NUMERIC_TITLE_SPEC = `
openapi: 3.0.0
info:
  version: 1.0.0
  title: 1.0
paths:
  /test:
    get:
      summary: Test GET endpoint
      operationId: testGet
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

/** A client that returns a fixed spec and counts its calls. */
class MockAPIHubClient implements BaseAPIHubClient {
  readonly getSpecContent = vi.fn(async () => this.spec);

  constructor(private readonly spec: string = MOCK_SPEC) {}
}

describe('APIHubToolset', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives its name and description from the spec', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(),
    });

    const tools = await toolset.getTools();

    expect(toolset.name).toBe('mock_api');
    expect(toolset.description).toBe('Mock API Description');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_get');
  });

  it('keeps the name and description the caller supplied', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(),
      name: 'my_toolset',
      description: 'My description',
    });

    await toolset.getTools();

    expect(toolset.name).toBe('my_toolset');
    expect(toolset.description).toBe('My description');
  });

  it('fetches the spec at construction time', async () => {
    const apihubClient = new MockAPIHubClient();

    new APIHubToolset({apihubResourceName: 'test_resource', apihubClient});

    expect(apihubClient.getSpecContent).toHaveBeenCalledWith('test_resource');
  });

  it('builds an APIHubClient when the caller supplies none', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('denied', {status: 403}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const toolset = new APIHubToolset({
      apihubResourceName:
        'projects/test-project/locations/us-central1/apis/test-api',
      accessToken: 'test_token',
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).rejects.toThrow(
      'API Hub request failed with status 403: denied',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis/test-api',
      expect.objectContaining({
        headers: expect.objectContaining({Authorization: 'Bearer test_token'}),
      }),
    );
  });

  it('defers the fetch until getTools when lazyLoadSpec is set', async () => {
    const apihubClient = new MockAPIHubClient();
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient,
      lazyLoadSpec: true,
    });
    expect(apihubClient.getSpecContent).not.toHaveBeenCalled();

    expect(await toolset.getTools()).toHaveLength(1);
    expect(await toolset.getTools()).toHaveLength(1);

    expect(apihubClient.getSpecContent).toHaveBeenCalledTimes(1);
  });

  it('fetches the spec once for concurrent getTools calls', async () => {
    const apihubClient = new MockAPIHubClient();
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient,
      lazyLoadSpec: true,
    });

    await Promise.all([toolset.getTools(), toolset.getTools()]);

    expect(apihubClient.getSpecContent).toHaveBeenCalledTimes(1);
  });

  it('names itself unnamed when the spec has no title', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(NO_TITLE_SPEC),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('unnamed');
  });

  it('names itself unnamed when the spec title is not a string', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(NUMERIC_TITLE_SPEC),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('unnamed');
  });

  it('leaves the description empty when the spec has none', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(EMPTY_DESCRIPTION_SPEC),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('empty_description_api');
    expect(toolset.description).toBe('');
  });

  it('generates tools with the auth scheme and credential', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(),
      authScheme: AUTH_SCHEME,
      authCredential: AUTH_CREDENTIAL,
    });

    expect(await toolset.getTools()).toHaveLength(1);
  });

  it('passes its tool filter to the generated tools', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(),
      toolFilter: ['other_tool'],
    });

    expect(await toolset.getTools()).toEqual([]);
  });

  it('returns no tools when the spec is empty', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(''),
      lazyLoadSpec: true,
    });

    expect(await toolset.getTools()).toEqual([]);
  });

  it('rejects when the spec parses to a scalar', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient('spec content'),
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).rejects.toThrow(
      "API Hub resource 'test_resource' is not an OpenAPI document.",
    );
  });

  it('rejects when the spec is not valid YAML', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient('{invalid yaml'),
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).rejects.toThrow();
  });

  it('does not raise an unhandled rejection when the eager fetch fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const toolset = new APIHubToolset({
        apihubResourceName: 'test_resource',
        apihubClient: {
          getSpecContent: () => Promise.reject(new Error('API Hub is down')),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
      await expect(toolset.getTools()).rejects.toThrow('API Hub is down');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('fetches the spec again after a failed preparation', async () => {
    const getSpecContent = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('API Hub is down'))
      .mockResolvedValueOnce(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: {getSpecContent},
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).rejects.toThrow('API Hub is down');
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(1);
    expect(getSpecContent).toHaveBeenCalledTimes(2);
  });

  it('closes the generated toolset', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(),
    });
    await toolset.getTools();

    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('closes before the spec is ever fetched', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(),
      lazyLoadSpec: true,
    });

    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
