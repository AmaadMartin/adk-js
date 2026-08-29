/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  FeatureName,
  overrideFeatureEnabled,
  RestApiTool,
} from '@google/adk';
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const SECRET_API_KEY = 'sk-live-secret-api-key-12345';

/** Answers every request with a JSON body under a text content type. */
function startServer(): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
    res.end(JSON.stringify({ok: true}));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('RestApiTool against a local server', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = await startServer();
    const {port} = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  function newTool(): RestApiTool {
    return new RestApiTool(
      'get_status',
      'Gets the status.',
      JSON.stringify({baseUrl, path: '/status', method: 'GET'}),
      JSON.stringify({operationId: 'get_status', responses: {}}),
    );
  }

  it('should parse a JSON body the server labels text/plain', async () => {
    const result = await newTool().runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(result).toEqual({ok: true});
  });

  it('should answer the same result through call', async () => {
    const result = await newTool().call({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(result).toEqual({ok: true});
  });

  it('should keep the credential out of the rendered tool', () => {
    const tool = newTool();
    tool.configureAuthScheme(
      '{"type":"apiKey","name":"X-API-Key","in":"header"}',
    );
    tool.configureAuthCredential(
      JSON.stringify({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: SECRET_API_KEY,
      }),
    );

    expect(tool.toRepr()).not.toContain(SECRET_API_KEY);
  });

  it('should switch declaration shape with the feature flag', () => {
    const tool = newTool();

    const off = tool._getDeclaration();
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    try {
      const on = tool._getDeclaration();
      expect(on.parameters).toBeUndefined();
      expect(on.parametersJsonSchema).toBeDefined();
    } finally {
      overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, undefined);
    }

    expect(off.parameters).toBeDefined();
    expect(off.parametersJsonSchema).toBeUndefined();
  });
});
