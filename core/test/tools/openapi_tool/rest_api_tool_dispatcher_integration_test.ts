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
import * as https from 'node:https';
import {OpenAPIV3} from 'openapi-types';
import {generate} from 'selfsigned';
import {Agent} from 'undici';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/** Generous enough for RSA key generation and TLS setup on a loaded runner. */
const HOOK_TIMEOUT_MS = 30000;

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
 * Drives the injected dispatcher against a real HTTPS server whose certificate
 * no CA store trusts. Without the dispatcher the handshake fails and the
 * request never reaches the server, so the contrast between the two proves the
 * option is honoured. Nothing here is mocked.
 */
describe('RestApiTool dispatcher', () => {
  let server: https.Server;
  let baseUrl: string;
  let agent: Agent;
  const received: ReceivedRequest[] = [];

  const operation: OpenAPIV3.OperationObject = {responses: {}};

  beforeAll(async () => {
    // Generated at run time: a committed key or certificate would fail the
    // repository's secretlint check.
    const pems = await generate([{name: 'commonName', value: 'localhost'}], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            {type: 2, value: 'localhost'},
            {type: 7, ip: '127.0.0.1'},
          ],
        },
      ],
    });
    server = https.createServer(
      {key: pems.private, cert: pems.cert},
      (req, res) => {
        received.push({method: req.method ?? '', path: req.url ?? ''});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({status: 'ok'}));
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail('the test server did not bind to a TCP port');
    }
    baseUrl = `https://127.0.0.1:${address.port}`;

    agent = new Agent({connect: {ca: pems.cert}});
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await agent.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('reaches an endpoint the default dispatcher cannot verify', async () => {
    const tool = new RestApiTool(
      'get_status',
      'Reads the status.',
      {baseUrl, path: '/status', method: 'get'},
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
      {baseUrl, path: '/unreachable', method: 'get'},
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
      {baseUrl, path: '/configured', method: 'get'},
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
      servers: [{url: baseUrl}],
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
