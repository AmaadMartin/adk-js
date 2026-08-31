/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APIHubToolset,
  AuthCredential,
  AuthCredentialTypes,
  BaseAPIHubClient,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it, vi} from 'vitest';

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

const INVALID_YAML_SPEC = '{invalid yaml';

const AUTH_SCHEME: OpenAPIV3.SecuritySchemeObject = {
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
  oauth2: {clientId: 'test_client_id', clientSecret: 'test_client_secret'},
};

function createMockClient(spec: string) {
  return {
    getSpecContent: vi.fn(async (_resourceName: string) => spec),
  } satisfies BaseAPIHubClient;
}

describe('APIHubToolset', () => {
  it('generates tools from the spec and derives name and description', async () => {
    const client = createMockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
    });

    expect(client.getSpecContent).toHaveBeenCalledTimes(1);

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_get');
    expect(toolset.name).toBe('mock_api');
    expect(toolset.description).toBe('Mock API Description');
    expect(client.getSpecContent).toHaveBeenCalledWith('test_resource');
  });

  it('defers the spec fetch until getTools when lazyLoadSpec is true', async () => {
    const client = createMockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
      lazyLoadSpec: true,
    });

    expect(client.getSpecContent).not.toHaveBeenCalled();

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_get');
    expect(client.getSpecContent).toHaveBeenCalledTimes(1);

    const reloadedTools = await toolset.getTools();

    expect(reloadedTools).toHaveLength(1);
    expect(client.getSpecContent).toHaveBeenCalledTimes(1);
  });

  it('falls back to "unnamed" when the spec has no title', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: createMockClient(NO_TITLE_SPEC),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('unnamed');
  });

  it('snake-cases the title and leaves the description empty when the spec has none', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: createMockClient(EMPTY_DESCRIPTION_SPEC),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('empty_description_api');
    expect(toolset.description).toBe('');
  });

  it('generates tools when an auth scheme and credential are supplied', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: createMockClient(MOCK_SPEC),
      authScheme: AUTH_SCHEME,
      authCredential: AUTH_CREDENTIAL,
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_get');
  });

  it('returns no tools when the spec content is empty', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: createMockClient(''),
      lazyLoadSpec: true,
    });

    const tools = await toolset.getTools();

    expect(tools).toEqual([]);
    // The empty spec returns before the name is derived, so it keeps its default.
    expect(toolset.name).toBe('');
  });

  it('latches an eager spec failure and rethrows it from getTools', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: createMockClient(INVALID_YAML_SPEC),
    });

    // The eager fetch has already rejected. Draining the macrotask queue before
    // getTools() makes vitest report an unhandled rejection unless the toolset
    // latched it, so this pins the latch as well as the rethrow.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(toolset.getTools()).rejects.toThrow();
  });
});

describe('APIHubToolset.close', () => {
  it('closes a toolset whose tools were loaded', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: createMockClient(MOCK_SPEC),
    });
    await toolset.getTools();

    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('closes a toolset that never loaded a spec', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: createMockClient(MOCK_SPEC),
      lazyLoadSpec: true,
    });

    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
