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
import * as http from 'node:http';
import {OpenAPIV3} from 'openapi-types';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * Drives RestApiTool against a real loopback HTTP server with the platform
 * `fetch`, so the response classification runs on a real `Response` rather
 * than on a hand-built double.
 */
describe('RestApiTool HTTP error handling against a live server', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(() => {
    server = http.createServer((req, res) => {
      switch (req.url) {
        case '/missing':
          res.writeHead(404, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({message: 'not found'}));
          break;
        case '/boom':
          res.writeHead(500, {'Content-Type': 'text/plain'});
          res.end('Internal Server Error');
          break;
        case '/created':
          res.writeHead(201, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({created: true}));
          break;
        default:
          res.writeHead(204);
          res.end();
      }
    });
    return new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          expect.fail('the test server did not bind a TCP port');
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function callPath(path: string): Promise<unknown> {
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      {baseUrl, path, method: 'GET'},
      operation,
    );
    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'invocation-1',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'session-1', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
    });
    return tool.runAsync({args: {}, toolContext});
  }

  it('should report a real 404 as an error payload carrying the body', async () => {
    const result = await callPath('/missing');

    expect(result).not.toEqual({message: 'not found'});
    expect(result).toEqual({
      error: expect.stringContaining(
        'Status Code: 404, {"message":"not found"}',
      ),
    });
  });

  it('should report a real 500 with the adk-python message', async () => {
    const result = await callPath('/boom');

    expect(result).toEqual({
      error:
        'Tool test_tool execution failed. Analyze this execution error and ' +
        'your inputs. Retry with adjustments if applicable. But make sure ' +
        "don't retry more than 3 times. Execution Error: Status Code: 500, " +
        'Internal Server Error',
    });
  });

  it('should return the parsed body of a real 201 response', async () => {
    expect(await callPath('/created')).toEqual({created: true});
  });

  it('should return an empty string for a real 204 response', async () => {
    expect(await callPath('/empty')).toBe('');
  });
});
