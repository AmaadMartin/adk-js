/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  MCPToolset,
  PluginManager,
} from '@google/adk';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {context, propagation, trace} from '@opentelemetry/api';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {fileURLToPath} from 'node:url';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` calls a real MCP server
 * (spawned as a stdio child process, see `mcp_tool_server.mjs`) that echoes the
 * `traceparent` it received in the request `_meta`. This proves the server can
 * read the trace context we send, which the unit tests cannot show.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_tool_server.mjs', import.meta.url),
);

/** The server reports this when the request carries no trace context. */
const NO_TRACE_CONTEXT = 'no-trace-context';

let toolset: MCPToolset | undefined;

afterEach(async () => {
  await toolset?.close();
  toolset = undefined;
});

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'trace-context-e2e',
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
      abortSignal: new AbortController().signal,
    }),
  });
}

/** Calls the real tool and returns the traceparent the server saw. */
async function echoedTraceparent(): Promise<string> {
  toolset = new MCPToolset({
    type: 'StdioConnectionParams',
    serverParams: {command: process.execPath, args: [SERVER_PATH]},
  });

  const [tool] = await toolset.getTools();
  const result = CallToolResultSchema.parse(
    await tool.runAsync({args: {}, toolContext: createToolContext()}),
  );

  const [part] = result.content;
  if (part.type !== 'text') {
    return expect.fail(`expected a text content part, got ${part.type}`);
  }
  return part.text;
}

describe('MCPTool trace context (e2e, real MCP server over stdio)', () => {
  describe('under a registered tracer provider', () => {
    const provider = new NodeTracerProvider();

    beforeAll(() => {
      provider.register();
    });

    afterAll(async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    });

    it('sends the active span context to the server', async () => {
      const tracer = trace.getTracer('mcp-tool-trace-context-e2e');

      await tracer.startActiveSpan('e2e-span', async (span) => {
        const traceparent = await echoedTraceparent();
        const {traceId, spanId} = span.spanContext();

        expect(traceparent).toBe(`00-${traceId}-${spanId}-01`);

        span.end();
      });
    });
  });

  describe('with no propagator registered', () => {
    beforeAll(() => {
      propagation.disable();
    });

    it('sends no trace context to the server', async () => {
      expect(await echoedTraceparent()).toBe(NO_TRACE_CONTEXT);
    });
  });
});
