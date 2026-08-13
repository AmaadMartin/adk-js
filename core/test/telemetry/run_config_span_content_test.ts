/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  ContentCapturingMode,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunConfig,
  createSession,
} from '@google/adk';
import {context, trace} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {handleFunctionCallsAsync} from '../../src/agents/functions.js';
import {createEvent} from '../../src/events/event.js';

class EchoTool extends BaseTool {
  constructor() {
    super({name: 'echo', description: 'Echoes its argument'});
  }

  override async runAsync({args}: {args: Record<string, unknown>}) {
    return {echoed: args.message};
  }
}

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

function invocationContextWith(runConfig?: RunConfig): InvocationContext {
  const agent = new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'});
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    runConfig,
  });
}

async function runEchoTool(runConfig?: RunConfig): Promise<ReadableSpan> {
  const tool = new EchoTool();
  await handleFunctionCallsAsync({
    invocationContext: invocationContextWith(runConfig),
    functionCallEvent: createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'echo', id: '1', args: {message: 'hello'}}},
        ],
      },
    }),
    toolsDict: {echo: tool},
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
  });

  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0];
}

async function runTwoEchoTools(runConfig?: RunConfig): Promise<ReadableSpan> {
  await handleFunctionCallsAsync({
    invocationContext: invocationContextWith(runConfig),
    functionCallEvent: createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'echo', id: '1', args: {message: 'hello'}}},
          {functionCall: {name: 'echo', id: '2', args: {message: 'hello'}}},
        ],
      },
    }),
    toolsDict: {echo: new EchoTool()},
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
  });

  const merged = exporter
    .getFinishedSpans()
    .find((span) => span.name === 'execute_tool (merged)');
  if (!merged) {
    expect.fail('no merged execute_tool span was exported');
  }
  return merged;
}

describe('RunConfig.telemetry against a real tracer', () => {
  beforeAll(() => {
    provider.register();
  });

  afterEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    trace.disable();
    context.disable();
    await provider.shutdown();
  });

  it('records the tool content when no telemetry config is supplied', async () => {
    const span = await runEchoTool();

    expect(span.attributes['gcp.vertex.agent.tool_call_args']).toContain(
      'hello',
    );
    expect(span.attributes['gcp.vertex.agent.tool_response']).toContain(
      'hello',
    );
  });

  it('empties the tool content for an invocation that opts out', async () => {
    const span = await runEchoTool({
      telemetry: {captureMessageContent: ContentCapturingMode.NO_CONTENT},
    });

    expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe('{}');
    expect(span.attributes['gcp.vertex.agent.tool_response']).toBe('{}');
  });

  it('records the merged tool response when no telemetry config is supplied', async () => {
    const span = await runTwoEchoTools();

    expect(span.attributes['gcp.vertex.agent.tool_response']).toContain(
      'hello',
    );
  });

  it('empties the merged tool response for an invocation that opts out', async () => {
    const span = await runTwoEchoTools({
      telemetry: {captureMessageContent: ContentCapturingMode.NO_CONTENT},
    });

    expect(span.attributes['gcp.vertex.agent.tool_response']).toBe('{}');
  });

  it('records the tool content for an invocation that opts in', async () => {
    const span = await runEchoTool({
      telemetry: {captureMessageContent: ContentCapturingMode.SPAN_AND_EVENT},
    });

    expect(span.attributes['gcp.vertex.agent.tool_call_args']).toContain(
      'hello',
    );
    expect(span.attributes['gcp.vertex.agent.tool_response']).toContain(
      'hello',
    );
  });
});
