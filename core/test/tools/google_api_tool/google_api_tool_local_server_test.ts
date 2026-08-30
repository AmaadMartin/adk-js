/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, GoogleApiTool, RestApiTool} from '@google/adk';
import {createServer, IncomingHttpHeaders, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {OpenAPIV3} from 'openapi-types';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * Drives `GoogleApiTool` against a real HTTP server over a real `fetch`, so
 * the headers asserted here are the headers that leave the process.
 */
describe('GoogleApiTool against a local server', () => {
  let server: Server;
  let baseUrl: string;
  let receivedHeaders: IncomingHttpHeaders;

  beforeAll(async () => {
    server = createServer((request, response) => {
      receivedHeaders = request.headers;
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({items: ['calendar-1']}));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const {port} = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function createTool(
    options: {additionalHeaders?: Record<string, string>} = {},
    operation: OpenAPIV3.OperationObject = {responses: {}},
  ): GoogleApiTool {
    const restApiTool = new RestApiTool(
      'list_calendars',
      'Lists the calendars on the user calendar list.',
      {baseUrl, path: '/calendars', method: 'GET'},
      operation,
    );
    return new GoogleApiTool(restApiTool, options);
  }

  it('sends an additional header and returns the parsed response body', async () => {
    const tool = createTool({
      additionalHeaders: {'developer-token': 'local-token'},
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(receivedHeaders['developer-token']).toBe('local-token');
    expect(result).toEqual({items: ['calendar-1']});
  });

  it('lets a request header win over an additional header of the same name', async () => {
    const tool = createTool(
      {additionalHeaders: {'developer-token': 'local-token'}},
      {
        responses: {},
        parameters: [
          {name: 'developer-token', in: 'header', schema: {type: 'string'}},
        ],
      },
    );

    await tool.runAsync({
      args: {'developer-token': 'from-request'},
      toolContext: {} as unknown as Context,
    });

    expect(receivedHeaders['developer-token']).toBe('from-request');
  });

  it('exposes the wrapped tool declaration', () => {
    const tool = createTool();

    const declaration = tool._getDeclaration();

    expect(declaration.name).toBe('list_calendars');
    expect(declaration.description).toBe(
      'Lists the calendars on the user calendar list.',
    );
  });
});
