/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  createSession,
  InvocationContext,
  OpenAPIToolset,
  PluginManager,
  RestApiTool,
  version,
} from '@google/adk';
import {createServer, IncomingHttpHeaders, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * Drives a RestApiTool against a loopback HTTP server with the real `fetch`,
 * so the assertions read the headers the server received rather than the
 * object the tool handed to `fetch`.
 */
describe('RestApiTool headers on the wire', () => {
  const received: IncomingHttpHeaders[] = [];
  let server: Server;
  let tool: RestApiTool;

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push(req.headers);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: true}));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const {port} = server.address() as AddressInfo;
    const toolset = new OpenAPIToolset({
      specDict: {
        openapi: '3.0.0',
        info: {title: 'echo', version: '1.0.0'},
        servers: [{url: `http://127.0.0.1:${port}`}],
        paths: {
          '/echo': {
            get: {
              operationId: 'echoHeaders',
              summary: 'Echo the request headers',
              responses: {'200': {description: 'ok'}},
            },
          },
        },
      },
    });
    const tools = await toolset.getTools();
    tool = tools[0] as RestApiTool;
  });

  afterAll(() => {
    server.close();
  });

  function createToolContext(): Context {
    return new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
        }),
        pluginManager: new PluginManager([]),
      }),
    });
  }

  it('should send the ADK user agent to the server', async () => {
    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(received.at(-1)?.['user-agent']).toBe(
      `google-adk/${version} (tool: echo_headers)`,
    );
  });

  it('should send a default header without displacing the ADK user agent', async () => {
    tool.setDefaultHeaders({
      'developer-token': 'token',
      'User-Agent': 'never-applied',
    });

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(received.at(-1)?.['developer-token']).toBe('token');
    expect(received.at(-1)?.['user-agent']).toBe(
      `google-adk/${version} (tool: echo_headers)`,
    );
  });

  it('should send the additional headers of a credential the spec declares no scheme for', async () => {
    tool.configureAuthCredential({
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token: 'test_token'},
        additionalHeaders: {'x-goog-user-project': 'test-project'},
      },
    });

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(received.at(-1)?.['x-goog-user-project']).toBe('test-project');
  });
});
