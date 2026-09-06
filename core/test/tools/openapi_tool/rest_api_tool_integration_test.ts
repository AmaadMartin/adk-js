/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  OpenAPIToolset,
  PluginManager,
} from '@google/adk';
import * as http from 'node:http';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

interface ReceivedRequest {
  contentType: string | undefined;
  body: Buffer;
}

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

describe('RestApiTool against a local HTTP server', () => {
  let server: http.Server;
  let baseUrl: string;
  let received: ReceivedRequest | undefined;

  beforeEach(async () => {
    received = undefined;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks),
        };
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({ok: true}));
      });
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

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function createUploadTool(
    mimeType: string,
    schema: OpenAPIV3.SchemaObject,
  ): Promise<BaseTool> {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Upload API', version: '1.0.0'},
      servers: [{url: baseUrl}],
      paths: {
        '/upload': {
          post: {
            operationId: 'upload_blob',
            requestBody: {content: {[mimeType]: {schema}}},
            responses: {'200': {description: 'ok'}},
          },
        },
      },
    };
    const toolset = new OpenAPIToolset({
      specStr: JSON.stringify(spec),
      specType: 'json',
    });
    const tools = await toolset.getTools();
    const tool = tools.find((candidate) => candidate.name === 'upload_blob');
    if (!tool) {
      expect.fail('the upload_blob tool was not created from the spec');
    }
    return tool;
  }

  it('sends the octet-stream payload and its Content-Type to the server', async () => {
    const tool = await createUploadTool('application/octet-stream', {
      type: 'string',
      format: 'binary',
    });

    const result = await tool.runAsync({
      args: {body: 'binary-payload'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({ok: true});
    if (!received) {
      expect.fail('the server received no request');
    }
    expect(received.contentType).toBe('application/octet-stream');
    expect(received.body.toString()).toBe('binary-payload');
  });

  it('lets fetch derive the urlencoded Content-Type the server sees', async () => {
    const tool = await createUploadTool('application/x-www-form-urlencoded', {
      type: 'object',
      properties: {foo: {type: 'string'}},
    });

    const result = await tool.runAsync({
      args: {foo: 'bar'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({ok: true});
    if (!received) {
      expect.fail('the server received no request');
    }
    expect(received.contentType).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
    expect(received.body.toString()).toBe('foo=bar');
  });
});
