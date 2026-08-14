/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  MCPConnectionParams,
  MCPSessionManager,
  MCPTool,
  PluginManager,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {CallToolRequest, Tool} from '@modelcontextprotocol/sdk/types.js';
import {
  context,
  propagation,
  TextMapPropagator,
  trace,
} from '@opentelemetry/api';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

describe('MCPTool', () => {
  it('passes abort signal to callTool', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const controller = new AbortController();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: signal},
    );
  });

  it('uses originalName for callTool when provided', async () => {
    const mockTool: Tool = {
      name: 'prefixed_test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager, 'test-tool');

    const controller = new AbortController();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: signal},
    );
  });

  it('respects abort signal when callTool rejects', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockImplementation((_params, _extra, options) => {
        if (options?.signal?.aborted) {
          return Promise.reject(new Error('Aborted'));
        }
        return Promise.resolve({content: []});
      }),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Aborted',
    );
  });

  it('closes session even when callTool throws an error', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockRejectedValue(new Error('Call failed')),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const invocationContext = {
      abortSignal: new AbortController().signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );

    // Assert that closeSession was still called despite the error
    expect(mockSessionManager.closeSession).toHaveBeenCalledWith(mockClient);
  });

  describe('trace context propagation', () => {
    const traceTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const stdioParams: MCPConnectionParams = {
      type: 'StdioConnectionParams',
      serverParams: {command: 'never-spawned'},
    };

    /** Runs the tool against a spied client and returns the params it sent. */
    async function callToolParams(): Promise<CallToolRequest['params']> {
      const client = new Client({name: 'test-client', version: '1.0.0'});
      const callTool = vi
        .spyOn(client, 'callTool')
        .mockResolvedValue({content: []});
      const sessionManager = new MCPSessionManager(stdioParams);
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue(client);
      vi.spyOn(sessionManager, 'closeSession').mockResolvedValue(undefined);
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
        }),
        pluginManager: new PluginManager([]),
        abortSignal: new AbortController().signal,
      });

      await new MCPTool(traceTool, sessionManager).runAsync({
        args: {},
        toolContext: new Context({invocationContext}),
      });

      return callTool.mock.calls[0][0];
    }

    it('omits _meta when no propagator is configured', async () => {
      const params = await callToolParams();

      expect(params).not.toHaveProperty('_meta');
    });

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

      it('injects the active trace context into _meta', async () => {
        const tracer = trace.getTracer('mcp-tool-test');

        await tracer.startActiveSpan('test-span', async (span) => {
          const params = await callToolParams();
          const {traceId, spanId, traceFlags} = span.spanContext();
          const flags = traceFlags.toString(16).padStart(2, '0');
          const traceparent = `00-${traceId}-${spanId}-${flags}`;

          expect(traceparent).toMatch(
            /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
          );
          expect(params._meta).toEqual({traceparent});

          span.end();
        });
      });
    });

    describe('under a propagator that emits several keys', () => {
      const carrier = {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'foo=bar',
        baggage: 'baz=qux',
      };
      const multiKeyPropagator: TextMapPropagator = {
        inject(_context, target, setter) {
          for (const [key, value] of Object.entries(carrier)) {
            setter.set(target, key, value);
          }
        },
        extract: (activeContext) => activeContext,
        fields: () => Object.keys(carrier),
      };

      beforeAll(() => {
        propagation.setGlobalPropagator(multiKeyPropagator);
      });

      afterAll(() => {
        propagation.disable();
      });

      it('carries every key the propagator emits', async () => {
        const params = await callToolParams();

        expect(params._meta).toEqual(carrier);
      });
    });
  });
});
