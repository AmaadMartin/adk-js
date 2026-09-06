/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Event,
  functionsExportedForTestingOnly,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {SpanStatusCode, trace} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

/** An error that classifies itself, the way an MCP tool failure does. */
class ClassifiedError extends Error {
  constructor(
    message: string,
    readonly errorType: string,
  ) {
    super(message);
  }
}

/** The error a plain throwing tool raises. */
class InventoryLookupError extends Error {}

/**
 * A tool that throws. `FunctionTool` re-wraps a thrown error into a plain
 * `Error`, which would flatten the class these tests assert on, so these
 * fixtures subclass `BaseTool` directly.
 */
class ThrowingTool extends BaseTool {
  constructor(private readonly error: unknown) {
    super({name: 'throwingTool', description: 'always throws'});
  }

  override async runAsync(): Promise<unknown> {
    throw this.error;
  }
}

/** A tool that succeeds, used to pin the unchanged success path. */
class SucceedingTool extends BaseTool {
  constructor() {
    super({name: 'succeedingTool', description: 'always succeeds'});
  }

  override async runAsync(): Promise<unknown> {
    return {result: 'tool executed'};
  }
}

describe('execute_tool span for a throwing tool', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let invocationContext: InvocationContext;

  // The tracer in tracing.ts caches its delegate on first use, so the provider
  // is registered once for the whole file and only the exporter is reset.
  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  beforeEach(() => {
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager: new PluginManager(),
    });
  });

  afterEach(() => {
    exporter.reset();
  });

  /** Runs one tool through the production call path and returns its event. */
  async function runTool(tool: BaseTool): Promise<Event | null> {
    const functionCall: FunctionCall = {
      id: 'call_1',
      name: tool.name,
      args: {},
    };
    return handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
  }

  /** Returns the single exported `execute_tool` span. */
  function toolSpan(tool: BaseTool): ReadableSpan {
    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === `execute_tool ${tool.name}`);
    expect(spans).toHaveLength(1);
    return spans[0];
  }

  it('marks the span as failed and records the exception', async () => {
    const tool = new ThrowingTool(new InventoryLookupError('sku not found'));

    await runTool(tool);

    const span = toolSpan(tool);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('InventoryLookupError');
    expect(span.attributes['error.type']).toBe('InventoryLookupError');
    expect(span.attributes['gen_ai.tool.name']).toBe('throwingTool');
    const exceptions = span.events.filter((e) => e.name === 'exception');
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].attributes?.['exception.message']).toBe(
      'sku not found',
    );
  });

  it('reports no response event on the error path', async () => {
    const tool = new ThrowingTool(new InventoryLookupError('sku not found'));

    await runTool(tool);

    const span = toolSpan(tool);
    expect('gcp.vertex.agent.event_id' in span.attributes).toBe(false);
    expect(span.attributes['gen_ai.tool.call.id']).toBe('<not specified>');
  });

  it('lets the exception reach the caller unchanged', async () => {
    const tool = new ThrowingTool(new InventoryLookupError('sku not found'));

    const event = await runTool(tool);

    expect(event?.content?.parts?.[0].functionResponse?.response).toEqual({
      error: 'sku not found',
    });
  });

  it('prefers the error type the thrown error classified itself with', async () => {
    const tool = new ThrowingTool(
      new ClassifiedError('upstream refused', 'TOOL_ERROR'),
    );

    await runTool(tool);

    const span = toolSpan(tool);
    expect(span.attributes['error.type']).toBe('TOOL_ERROR');
    expect(span.status.message).toBe('TOOL_ERROR');
  });

  it('leaves the span of a succeeding tool clean', async () => {
    const tool = new SucceedingTool();

    await runTool(tool);

    const span = toolSpan(tool);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect('error.type' in span.attributes).toBe(false);
    expect(span.events.filter((e) => e.name === 'exception')).toHaveLength(0);
  });
});
