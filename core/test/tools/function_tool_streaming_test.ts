/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  Context,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TOOL_NAME = 'stock_stream';

function makeContext(
  activeStreamingTools?: Record<string, ActiveStreamingTool>,
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      pluginManager: new PluginManager([]),
      activeStreamingTools,
    }),
    functionCallId: 'fc-1',
  });
}

/** A tool that reports the input stream it was handed. */
function streamReportingTool() {
  return new FunctionTool({
    name: TOOL_NAME,
    description: 'Streams stock prices.',
    execute: (_input, _toolContext, inputStream) => inputStream,
  });
}

describe('FunctionTool input stream injection', () => {
  it('injects the stream registered under the tool name', async () => {
    const stream = new LiveRequestQueue();
    const toolContext = makeContext({
      [TOOL_NAME]: new ActiveStreamingTool({stream}),
    });

    const received = await streamReportingTool().runAsync({
      args: {},
      toolContext,
    });

    expect(received).toBe(stream);
  });

  it('injects nothing when another tool owns the only stream', async () => {
    const toolContext = makeContext({
      other_tool: new ActiveStreamingTool({stream: new LiveRequestQueue()}),
    });

    expect(
      await streamReportingTool().runAsync({args: {}, toolContext}),
    ).toBeUndefined();
  });

  it('injects nothing when the registered entry carries no stream', async () => {
    const toolContext = makeContext({
      [TOOL_NAME]: new ActiveStreamingTool(),
    });

    expect(
      await streamReportingTool().runAsync({args: {}, toolContext}),
    ).toBeUndefined();
  });

  it('injects nothing when the invocation runs no streaming tool', async () => {
    expect(
      await streamReportingTool().runAsync({
        args: {},
        toolContext: makeContext(),
      }),
    ).toBeUndefined();
  });

  it('tolerates a tool context with no invocation context', async () => {
    const toolContext = {} as Context;

    expect(
      await streamReportingTool().runAsync({args: {}, toolContext}),
    ).toBeUndefined();
  });

  it('leaves a two-parameter execute unaffected', async () => {
    const tool = new FunctionTool({
      name: TOOL_NAME,
      description: 'Streams stock prices.',
      execute: (_input, toolContext) => toolContext?.functionCallId,
    });
    const toolContext = makeContext({
      [TOOL_NAME]: new ActiveStreamingTool({stream: new LiveRequestQueue()}),
    });

    expect(await tool.runAsync({args: {}, toolContext})).toBe('fc-1');
  });

  it('reads a request the framework pushed onto the injected stream', async () => {
    const stream = new LiveRequestQueue();
    const toolContext = makeContext({
      [TOOL_NAME]: new ActiveStreamingTool({stream}),
    });
    const tool = new FunctionTool({
      name: TOOL_NAME,
      description: 'Streams stock prices.',
      execute: async (_input, _toolContext, inputStream) => {
        const request = await inputStream?.get();
        return request?.content?.parts?.[0]?.text;
      },
    });

    const running = tool.runAsync({args: {}, toolContext});
    stream.sendContent({parts: [{text: 'GOOG 1234'}]});

    expect(await running).toBe('GOOG 1234');
  });
});
