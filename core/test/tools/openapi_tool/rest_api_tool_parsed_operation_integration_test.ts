/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createRestApiToolFromJson,
  createSession,
  InvocationContext,
  LlmAgent,
  OpenApiSpecParser,
  ParsedOperation,
  PluginManager,
} from '@google/adk';
import {createServer, IncomingMessage, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {OpenAPIV3} from 'openapi-types';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * Drives a tool rebuilt from a serialized `ParsedOperation` against a real
 * loopback HTTP server with the platform `fetch`, so the assertions read the
 * request the server received.
 */
describe('RestApiTool built from a serialized parsed operation', () => {
  const received: Array<{url: string; method: string}> = [];
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      received.push({url: req.url ?? '', method: req.method ?? ''});
      if (req.url?.startsWith('/v1/notes/')) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({title: 'a note'}));
        return;
      }
      res.writeHead(200, {'content-type': 'text/plain'});
      res.end('plain body');
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

  function parseSpec(path: string): ParsedOperation {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.3',
      info: {title: 'Notes API', version: '1.0.0'},
      servers: [{url: baseUrl}],
      paths: {
        [path]: {
          get: {
            operationId: 'getNote',
            parameters: [
              {
                name: 'noteId',
                in: 'path',
                required: true,
                schema: {type: 'string'},
              },
              {name: 'view', in: 'query', schema: {type: 'string'}},
            ],
            responses: {'200': {description: 'ok'}},
          },
        },
      },
    };
    const [parsed] = new OpenApiSpecParser().parse(spec);
    return parsed;
  }

  it('should send the resolved path, the declared value and the embedded one', async () => {
    const tool = createRestApiToolFromJson(
      JSON.stringify(
        parseSpec('/v1/notes/{noteId}?view=embedded&fields=title#anchor'),
      ),
    );

    const result = await tool.runAsync({
      args: {note_id: '42', view: 'full'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({title: 'a note'});
    expect(received.at(-1)).toEqual({
      url: '/v1/notes/42?view=full&fields=title',
      method: 'GET',
    });
  });

  it('should wrap a non-JSON body in a text field', async () => {
    const tool = createRestApiToolFromJson(
      JSON.stringify(parseSpec('/v1/plain/{noteId}')),
    );

    const result = await tool.runAsync({
      args: {note_id: '7'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({text: 'plain body'});
  });
});
