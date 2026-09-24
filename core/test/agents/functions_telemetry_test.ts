/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Event,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LongRunningFunctionTool,
  PluginManager,
  Session,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {z} from 'zod';
import {logger} from '../../src/utils/logger.js';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

/**
 * `traceToolCall` writes the argument and response attributes only when
 * `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` allows it. Mirroring the gate here
 * keeps the expectations exact whatever the ambient value is, without the test
 * changing it.
 */
const captureEnv = process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS || 'true';
const capturesContent = captureEnv === 'true' || captureEnv === '1';

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
});

beforeEach(() => {
  exporter.reset();
  // One case deliberately names a tool that is not registered; keep the
  // expected diagnostic out of the suite output.
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const testTool = new FunctionTool({
  name: 'testTool',
  description: 'test tool',
  parameters: z.object({}),
  execute: async () => ({result: 'tool executed'}),
});

const otherTool = new FunctionTool({
  name: 'otherTool',
  description: 'other tool',
  parameters: z.object({}),
  execute: async () => ({result: 'other executed'}),
});

const errorTool = new FunctionTool({
  name: 'errorTool',
  description: 'error tool',
  parameters: z.object({}),
  execute: async () => {
    throw new Error('tool error message content');
  },
});

/**
 * Throws a value that is not an `Error`. `FunctionTool` wraps whatever its
 * handler throws into an `Error`, so reaching that branch needs a tool that
 * implements `runAsync` itself.
 */
class NonErrorThrowingTool extends BaseTool {
  constructor() {
    super({name: 'nonErrorThrowingTool', description: 'throws a plain value'});
  }

  override async runAsync(): Promise<unknown> {
    throw 'plain string failure';
  }
}

const nonErrorThrowingTool = new NonErrorThrowingTool();

const deferredTool = new LongRunningFunctionTool({
  name: 'deferredTool',
  description: 'long running tool that answers later',
  parameters: z.object({}),
  execute: async () => undefined,
});

function newInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_123',
    session: {} as Session,
    agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
    pluginManager: new PluginManager(),
  });
}

function callFor(tool: BaseTool, id: string): FunctionCall {
  return {id, name: tool.name, args: {}};
}

function run({
  functionCalls,
  toolsDict,
  beforeToolCallbacks = [],
  afterToolCallbacks = [],
}: {
  functionCalls: FunctionCall[];
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks?: SingleBeforeToolCallback[];
  afterToolCallbacks?: SingleAfterToolCallback[];
}): Promise<Event | null> {
  return handleFunctionCallList({
    invocationContext: newInvocationContext(),
    functionCalls,
    toolsDict,
    beforeToolCallbacks,
    afterToolCallbacks,
  });
}

function spansNamed(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

function onlySpan(name: string): ReadableSpan {
  const matches = spansNamed(name);
  expect(matches.map((s) => s.name)).toEqual([name]);
  return matches[0];
}

/** Reads the response the given event carries back to the model. */
function emittedResponse(event: Event): unknown {
  const functionResponse = event.content?.parts?.[0]?.functionResponse;
  if (!functionResponse) {
    return expect.fail('event carries no function response');
  }
  return functionResponse.response;
}

/** Asserts the span traced the response the event actually carries. */
function expectTracedResponse(span: ReadableSpan, event: Event): void {
  expect(span.attributes['gcp.vertex.agent.tool_response']).toBe(
    capturesContent ? JSON.stringify(emittedResponse(event)) : '{}',
  );
}

describe('execute_tool span', () => {
  it('keys the span by the id of the event it emits', async () => {
    const event = await run({
      functionCalls: [callFor(testTool, 'call_1')],
      toolsDict: {testTool},
    });

    expect(event).not.toBeNull();
    const span = onlySpan('execute_tool testTool');
    expect(span.attributes['gcp.vertex.agent.event_id']).toBe(event!.id);
  });

  it('records the call id, the tool and the response', async () => {
    const event = await run({
      functionCalls: [callFor(testTool, 'call_1')],
      toolsDict: {testTool},
    });

    const span = onlySpan('execute_tool testTool');
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'testTool',
      'gen_ai.tool.description': 'test tool',
      'gen_ai.tool.call.id': 'call_1',
    });
    expect(emittedResponse(event!)).toEqual({result: 'tool executed'});
    expectTracedResponse(span, event!);
  });

  it('traces empty arguments for a call that carries none', async () => {
    const event = await run({
      functionCalls: [{id: 'call_1', name: testTool.name}],
      toolsDict: {testTool},
    });

    const span = onlySpan('execute_tool testTool');
    expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe('{}');
    expect(span.attributes['gcp.vertex.agent.event_id']).toBe(event!.id);
  });

  it('traces the response an after-tool callback substituted', async () => {
    const event = await run({
      functionCalls: [callFor(testTool, 'call_1')],
      toolsDict: {testTool},
      afterToolCallbacks: [async () => ({result: 'overridden'})],
    });

    const span = onlySpan('execute_tool testTool');
    expect(emittedResponse(event!)).toEqual({result: 'overridden'});
    expectTracedResponse(span, event!);
    expect(span.attributes['gcp.vertex.agent.tool_response']).not.toContain(
      'tool executed',
    );
    expect(span.attributes['gcp.vertex.agent.event_id']).toBe(event!.id);
  });

  it('traces a call a before-tool callback answered without the tool', async () => {
    const event = await run({
      functionCalls: [callFor(testTool, 'call_1')],
      toolsDict: {testTool},
      beforeToolCallbacks: [async () => ({result: 'short circuited'})],
    });

    const span = onlySpan('execute_tool testTool');
    expect(emittedResponse(event!)).toEqual({result: 'short circuited'});
    expect(span.attributes['gcp.vertex.agent.event_id']).toBe(event!.id);
    expectTracedResponse(span, event!);
  });

  it('traces the error response of a tool that throws', async () => {
    const event = await run({
      functionCalls: [callFor(errorTool, 'call_1')],
      toolsDict: {errorTool},
    });

    const span = onlySpan('execute_tool errorTool');
    expect(emittedResponse(event!)).toEqual({
      error: "Error in tool 'errorTool': tool error message content",
    });
    expect(span.attributes['gcp.vertex.agent.event_id']).toBe(event!.id);
    expectTracedResponse(span, event!);
  });

  it('traces the error response of a tool that throws a plain value', async () => {
    const event = await run({
      functionCalls: [callFor(nonErrorThrowingTool, 'call_1')],
      toolsDict: {nonErrorThrowingTool},
    });

    const span = onlySpan('execute_tool nonErrorThrowingTool');
    expect(emittedResponse(event!)).toEqual({error: 'plain string failure'});
    expect(span.attributes['gcp.vertex.agent.event_id']).toBe(event!.id);
    expectTracedResponse(span, event!);
  });

  it('ends the span without an event id when a long-running tool defers', async () => {
    const event = await run({
      functionCalls: [callFor(deferredTool, 'call_1')],
      toolsDict: {deferredTool},
    });

    expect(event).toBeNull();
    const span = onlySpan('execute_tool deferredTool');
    expect(span.ended).toBe(true);
    expect(span.attributes['gcp.vertex.agent.event_id']).toBeUndefined();
  });

  it('gives each parallel call its own span and event id', async () => {
    const merged = await run({
      functionCalls: [
        callFor(testTool, 'call_1'),
        callFor(otherTool, 'call_2'),
      ],
      toolsDict: {testTool, otherTool},
    });

    const first = onlySpan('execute_tool testTool');
    const second = onlySpan('execute_tool otherTool');
    const firstEventId = first.attributes['gcp.vertex.agent.event_id'];
    const secondEventId = second.attributes['gcp.vertex.agent.event_id'];
    expect(firstEventId).toBeTypeOf('string');
    expect(firstEventId).not.toBe(secondEventId);
    expect(first.attributes['gen_ai.tool.call.id']).toBe('call_1');
    expect(second.attributes['gen_ai.tool.call.id']).toBe('call_2');

    const mergedSpan = onlySpan('execute_tool (merged)');
    expect(mergedSpan.attributes['gcp.vertex.agent.event_id']).toBe(merged!.id);
  });

  it('leaves the unresolvable call with its single span', async () => {
    const event = await run({
      functionCalls: [{id: 'call_1', name: 'missingTool', args: {}}],
      toolsDict: {testTool},
    });

    expect(event).not.toBeNull();
    expect(spansNamed('execute_tool missingTool')).toHaveLength(1);
  });
});
