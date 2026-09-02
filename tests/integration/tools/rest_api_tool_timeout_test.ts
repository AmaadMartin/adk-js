/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import {createServer, Server} from 'node:http';
import {Socket} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/** Wall-clock budget for the call, well under the tool's own deadline. */
const CALL_TIMEOUT_MS = 5000;

describe('RestApiTool against a server that never answers', () => {
  const sockets: Socket[] = [];
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // The handler never writes a response, so the client waits for its own
    // deadline instead of for the server.
    server = createServer(() => {});
    server.on('connection', (socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail('the test server did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  });

  it(
    'returns the timeout error instead of hanging',
    async () => {
      const tool = new RestApiTool(
        'slow_tool',
        'Calls an endpoint that never answers.',
        {baseUrl, path: '/hang', method: 'get'},
        {responses: {}},
        undefined,
        undefined,
        {timeoutMs: 300},
      );

      const result = await tool.runAsync({
        args: {},
        toolContext: new Context({
          invocationContext: new InvocationContext({
            invocationId: 'inv-timeout-integration',
            session: createSession({id: 'session-1', appName: 'test-app'}),
            pluginManager: new PluginManager([]),
          }),
        }),
      });

      expect(result).toEqual({
        error:
          'Tool slow_tool execution failed. Analyze this execution error and' +
          ' your inputs. Retry with adjustments if applicable. But make sure' +
          " don't retry more than 3 times. Execution Error: Request timed out" +
          ' (TimeoutError).',
      });
    },
    CALL_TIMEOUT_MS,
  );
});
