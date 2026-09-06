/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, OpenAPIToolset} from '@google/adk';
import * as http from 'node:http';
import {OpenAPIV3} from 'openapi-types';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createRunner, GeminiWithMockResponses} from '../test_case_utils.js';

/**
 * Drives an OpenAPI tool over a real HTTP connection to prove that a query
 * parameter the model sets to null never reaches the server. Nothing is
 * mocked below the model: the request is built, sent and received for real.
 */
describe('OpenAPI null query parameter', () => {
  let server: http.Server;
  let port: number;
  const requestedUrls: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requestedUrls.push(req.url ?? '');
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({items: []}));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail('the test server did not report a TCP address');
    }
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function createSpec(): OpenAPIV3.Document {
    return {
      openapi: '3.0.0',
      info: {title: 'Items API', version: '1.0.0'},
      servers: [{url: `http://127.0.0.1:${port}`}],
      paths: {
        '/items': {
          get: {
            operationId: 'list_items',
            parameters: [
              {name: 'q', in: 'query', schema: {type: 'string'}},
              {name: 'limit', in: 'query', schema: {type: 'integer'}},
            ],
            responses: {
              '200': {
                description: 'Success',
                content: {'application/json': {schema: {type: 'object'}}},
              },
            },
          },
        },
      },
    };
  }

  it('should not send a query parameter the model set to null', async () => {
    const toolset = new OpenAPIToolset({specDict: createSpec()});
    const agent = new LlmAgent({
      name: 'items_agent',
      description: 'Lists items.',
      instruction: 'Call list_items to list the items.',
      tools: [toolset],
    });
    agent.model = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'list_items',
                    args: {q: 'shoes', limit: null},
                  },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {content: {role: 'model', parts: [{text: 'There are no items.'}]}},
        ],
      },
    ]);

    const runner = await createRunner(agent);
    for await (const _ of runner.run('List the shoes.')) {
      // Drain the run so the tool call completes.
    }

    expect(requestedUrls).toEqual(['/items?q=shoes']);
  });
});
