/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  FetchFn,
  InvocationContext,
  LlmAgent,
  OpenAPIToolset,
  PluginManager,
  version,
} from '@google/adk';
import {readFileSync} from 'node:fs';
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * Proves `OpenAPIToolset` hands its `fetchFn` to every tool it builds. The
 * supplied function issues the real request against a loopback server, so a
 * toolset that accepted the option and dropped it would be visible here.
 */
describe('OpenAPIToolset fetchFn', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({id: 9, name: 'rex'}));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('should issue every tool call through the supplied fetch', async () => {
    const calls: Array<{url: string; headers: Headers}> = [];
    const fetchFn: FetchFn = async (input, init) => {
      calls.push({url: String(input), headers: new Headers(init?.headers)});
      // The spec names a public host, so the request is redirected to the
      // loopback server rather than sent to the internet.
      const requested = new URL(String(input));
      return fetch(`${baseUrl}${requested.pathname}${requested.search}`, init);
    };
    const toolset = new OpenAPIToolset({
      specStr: readFileSync(join(__dirname, 'fixtures/truanon.yaml'), 'utf8'),
      specType: 'yaml',
      fetchFn,
    });
    const tools = await toolset.getTools();
    const getProfile = tools.find((tool) => tool.name === 'get_profile');
    if (!getProfile) expect.fail('get_profile tool was not created');

    const result = await getProfile.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: new Context({
        invocationContext: new InvocationContext({
          invocationId: 'invocation-1',
          agent: new LlmAgent({name: 'test_agent'}),
          session: createSession({id: 'session-1', appName: 'test_app'}),
          pluginManager: new PluginManager(),
        }),
      }),
    });

    expect(result).toEqual({id: 9, name: 'rex'});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://staging.truanon.com/api/get_profile?id=user1&service=myservice',
    );
    expect(calls[0].headers.get('user-agent')).toBe(
      `google-adk/${version} (tool: get_profile)`,
    );
  });
});
