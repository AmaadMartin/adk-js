/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APIHubToolset,
  BaseAPIHubClient,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const TWO_OPERATION_SPEC = `
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
    post:
      summary: Test POST endpoint
      operationId: testPost
      responses:
        '200':
          description: Successful response
`;

class SpecClient implements BaseAPIHubClient {
  callCount = 0;

  constructor(private readonly spec: string = TWO_OPERATION_SPEC) {}

  async getSpecContent(_apihubResourceName: string): Promise<string> {
    this.callCount++;
    return this.spec;
  }
}

class FailingClient implements BaseAPIHubClient {
  async getSpecContent(_apihubResourceName: string): Promise<string> {
    throw new Error('API Hub is unreachable');
  }
}

function readonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('APIHubToolset options', () => {
  it('builds an API Hub client when none is supplied', async () => {
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response('forbidden', {status: 403}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const toolset = new APIHubToolset({
      apihubResourceName: 'projects/p/locations/us-central1/apis/a',
      accessToken: 'test-token',
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).rejects.toThrow(
      'API Hub request failed with status 403: forbidden',
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://apihub.googleapis.com/v1/projects/p/locations/us-central1/apis/a',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: {Authorization: 'Bearer test-token'},
    });
  });

  it('applies toolFilter to the generated tools', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new SpecClient(),
      toolFilter: ['test_post'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['test_post']);
    expect(await toolset.getTool('test_get')).toBeUndefined();
  });

  it('applies a toolFilter predicate with a context', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new SpecClient(),
      toolFilter: (tool) => tool.name.endsWith('_get'),
    });

    const tools = await toolset.getTools(readonlyContext());

    expect(tools.map((tool) => tool.name)).toEqual(['test_get']);
  });

  it('prefixes every generated tool name', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new SpecClient(),
      prefix: 'hub',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'hub_test_get',
      'hub_test_post',
    ]);
  });

  it('keeps an explicit name and description over the spec', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new SpecClient(),
      name: 'my_api',
      description: 'My description',
    });

    await toolset.getTools();

    expect(toolset.name).toBe('my_api');
    expect(toolset.description).toBe('My description');
  });

  it('fetches the spec once and returns the same tools', async () => {
    const apihubClient = new SpecClient();
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient,
    });

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(apihubClient.callCount).toBe(1);
    expect(second[0]).toBe(first[0]);
  });

  it('closes without fetching a spec it never loaded', async () => {
    const apihubClient = new SpecClient();
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient,
      lazyLoadSpec: true,
    });

    await expect(toolset.close()).resolves.toBeUndefined();
    expect(apihubClient.callCount).toBe(0);
  });

  it('closes a loaded toolset', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new SpecClient(),
    });
    await toolset.getTools();

    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('closes an empty spec without a toolset to close', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new SpecClient(''),
    });
    await toolset.getTools();

    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('closes after a failed fetch instead of reporting it again', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new FailingClient(),
    });

    await expect(toolset.getTools()).rejects.toThrow('API Hub is unreachable');
    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('reports a failed fetch on getTool as well', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new FailingClient(),
      lazyLoadSpec: true,
    });

    await expect(toolset.getTool('test_get')).rejects.toThrow(
      'API Hub is unreachable',
    );
  });
});
