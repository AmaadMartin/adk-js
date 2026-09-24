/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python v0.1.0:
// tests/unittests/tools/apihub_tool/test_apihub_toolset.py

import {
  APIHubToolset,
  AuthCredential,
  AuthCredentialTypes,
  BaseAPIHubClient,
} from '@google/adk';
import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

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

/** Returns the reference fixture: a client serving one fixed spec. */
class MockAPIHubClient implements BaseAPIHubClient {
  callCount = 0;

  constructor(private readonly spec: string = MOCK_SPEC) {}

  async getSpecContent(_apihubResourceName: string): Promise<string> {
    this.callCount++;
    return this.spec;
  }
}

const mockAuthScheme: OpenAPIV3.SecuritySchemeObject = {
  type: 'apiKey',
  in: 'query',
  name: 'api_key',
};

const mockAuthCredential: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'test-api-key',
};

function basicApihubToolset(): APIHubToolset {
  return new APIHubToolset({
    apihubResourceName: 'test_resource',
    apihubClient: new MockAPIHubClient(),
  });
}

describe('APIHubToolset', () => {
  it('test_apihub_toolset_initialization', async () => {
    const toolset = basicApihubToolset();

    const tools = await toolset.getTools();

    expect(toolset.name).toBe('mock_api');
    expect(toolset.description).toBe('Mock API Description');
    expect(toolset.apihubResourceName).toBe('test_resource');
    expect(toolset.lazyLoadSpec).toBe(false);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_get');
  });

  it('test_apihub_toolset_lazy_loading', async () => {
    const apihubClient = new MockAPIHubClient();
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient,
      lazyLoadSpec: true,
    });

    expect(toolset.lazyLoadSpec).toBe(true);
    expect(apihubClient.callCount).toBe(0);

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(1);
    expect(await toolset.getTool('test_get')).toBe(tools[0]);
    expect(apihubClient.callCount).toBe(1);
  });

  it('test_apihub_toolset_no_title_in_spec', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(NO_TITLE_SPEC),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('unnamed');
  });

  it('test_apihub_toolset_empty_description_in_spec', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(EMPTY_DESCRIPTION_SPEC),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('empty_description_api');
    expect(toolset.description).toBe('');
  });

  it('test_get_tools_with_auth', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(),
      authScheme: mockAuthScheme,
      authCredential: mockAuthCredential,
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(1);
  });

  it('test_apihub_toolset_get_tools_lazy_load_empty_spec', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient(''),
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).resolves.toEqual([]);
  });

  it('test_apihub_toolset_get_tools_invalid_yaml', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: new MockAPIHubClient('{invalid yaml'),
    });

    await expect(toolset.getTools()).rejects.toThrow(yaml.YAMLException);
  });
});
