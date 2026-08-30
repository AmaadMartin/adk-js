/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  GoogleApiTool,
  InvocationContext,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import {createServer, IncomingHttpHeaders, Server} from 'node:http';
import {OpenAPIV3} from 'openapi-types';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/** Binds the server to a free loopback port and reports which one. */
function listenOnFreePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

/**
 * Drives `GoogleApiTool` against a real HTTP server over a real `fetch`, so
 * the headers asserted here are the headers that leave the process.
 */
describe('GoogleApiTool against a local server', () => {
  let server: Server;
  let baseUrl: string;
  let receivedHeaders: IncomingHttpHeaders = {};

  beforeAll(async () => {
    server = createServer((request, response) => {
      receivedHeaders = request.headers;
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({items: ['calendar-1']}));
    });

    baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
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
      toolContext: createToolContext(),
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
      toolContext: createToolContext(),
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
