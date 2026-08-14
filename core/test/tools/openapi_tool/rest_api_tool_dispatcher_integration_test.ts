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
  OpenAPIToolset,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {OpenAPIV3} from 'openapi-types';
import {Agent} from 'undici';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * A host DNS can never resolve, reserved for this purpose by RFC 6761 section
 * 6.4. The default dispatcher therefore cannot reach the test server.
 */
const BASE_URL = 'http://adk-dispatcher-test.invalid';

interface ReceivedRequest {
  method: string;
  path: string;
}

/** Builds the tool context the way the sibling OpenAPI suites do. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'session-1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

/**
 * Drives the injected dispatcher against a real HTTP server bound to a local
 * socket that no DNS name points at. Only a dispatcher carrying the socket
 * path can reach it, so the contrast between the two proves the option is
 * honoured. Nothing here is mocked.
 */
describe('RestApiTool dispatcher', () => {
  let server: http.Server;
  let socketDir: string | undefined;
  let agent: Agent;
  const received: ReceivedRequest[] = [];

  const operation: OpenAPIV3.OperationObject = {responses: {}};

  beforeAll(async () => {
    let socketPath: string;
    if (process.platform === 'win32') {
      socketPath = path.join('\\\\.\\pipe', `adk-dispatcher-${process.pid}`);
    } else {
      socketDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-dispatcher-'));
      socketPath = path.join(socketDir, 'api.sock');
    }

    server = http.createServer((req, res) => {
      received.push({method: req.method ?? '', path: req.url ?? ''});
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({status: 'ok'}));
    });
    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });

    agent = new Agent({connect: {socketPath}});
  });

  afterAll(async () => {
    await agent.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (socketDir) {
      await fs.rm(socketDir, {recursive: true, force: true});
    }
  });

  it('reaches an endpoint the default dispatcher cannot resolve', async () => {
    const tool = new RestApiTool(
      'get_status',
      'Reads the status.',
      {baseUrl: BASE_URL, path: '/status', method: 'get'},
      operation,
      undefined,
      undefined,
      {dispatcher: agent},
    );

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'ok'});
    expect(received).toContainEqual({method: 'GET', path: '/status'});
  });

  it('fails the same call when no dispatcher is supplied', async () => {
    const tool = new RestApiTool(
      'get_status',
      'Reads the status.',
      {baseUrl: BASE_URL, path: '/unreachable', method: 'get'},
      operation,
    );

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      error: expect.stringContaining('Failed to execute API call'),
    });
    expect(received).not.toContainEqual({
      method: 'GET',
      path: '/unreachable',
    });
  });

  it('uses a dispatcher installed by configureDispatcher', async () => {
    const tool = new RestApiTool(
      'get_status',
      'Reads the status.',
      {baseUrl: BASE_URL, path: '/configured', method: 'get'},
      operation,
    );

    tool.configureDispatcher(agent);
    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'ok'});
    expect(received).toContainEqual({method: 'GET', path: '/configured'});
  });

  it('forwards the toolset dispatcher to every tool it creates', async () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.3',
      info: {title: 'Status API', version: '1.0.0'},
      servers: [{url: BASE_URL}],
      paths: {
        '/toolset': {
          get: {
            operationId: 'getToolsetStatus',
            responses: {'200': {description: 'ok'}},
          },
        },
      },
    };
    const toolset = new OpenAPIToolset({specDict: spec, dispatcher: agent});
    const tools = await toolset.getTools();
    const tool = tools.find((t) => t.name === 'get_toolset_status');
    if (!tool) expect.fail('get_toolset_status tool was not created');

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'ok'});
    expect(received).toContainEqual({method: 'GET', path: '/toolset'});
  });
});
