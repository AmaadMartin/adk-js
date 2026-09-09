/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import {createServer, Server} from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

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
    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail('the server did not report a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('should parse a JSON body the server labels text/plain', async () => {
    const tool = new RestApiTool(
      'get_status',
      'Gets the status.',
      {baseUrl, path: '/status', method: 'GET'},
      {operationId: 'get_status', responses: {}},
    );

    const result = await tool.runAsync({
      args: {},
      toolContext: new Context({
        invocationContext: new InvocationContext({
          invocationId: 'invocation-1',
          agent: new LlmAgent({name: 'test_agent'}),
          session: createSession({id: 'session-1', appName: 'test_app'}),
          pluginManager: new PluginManager(),
        }),
      }),
    });

    expect(result).toEqual({ok: true});
  });
});
