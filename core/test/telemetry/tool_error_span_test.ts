/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  createEvent,
  Event,
  functionsExportedForTestingOnly,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
} from '@google/adk';
import {SpanStatusCode, trace} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';

import {traceToolCall} from '../../src/telemetry/tracing.js';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

/** A tool that reports failures in its response rather than by throwing. */
class InventoryTool extends BaseTool {
  constructor(private readonly response: Record<string, unknown>) {
    super({name: 'inventoryTool', description: 'looks a SKU up'});
  }

  override async runAsync(): Promise<unknown> {
    return this.response;
  }

  override detectErrorInResponse(response: unknown): string | undefined {
    return typeof response === 'object' &&
      response !== null &&
      'status' in response &&
      response.status === 'ERROR'
      ? 'TOOL_ERROR'
      : undefined;
  }
}

// Spans are recorded for real rather than stubbed, so these assertions pin
// what an operator would actually see in an exported trace.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

const SPAN_NAME = 'execute_tool inventoryTool';

function exportedSpan(): ReadableSpan {
  const span = exporter
    .getFinishedSpans()
    .find((finished) => finished.name === SPAN_NAME);
  if (!span) {
    expect.fail(`no ${SPAN_NAME} span was exported`);
  }
  return span;
}

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
});

describe('traceToolCall error reporting', () => {
  const tool = new InventoryTool({status: 'ERROR'});
  let responseEvent: Event;

  beforeEach(() => {
    responseEvent = createEvent({
      invocationId: 'inv_123',
      author: 'test_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc_1',
              name: tool.name,
              response: {status: 'ERROR'},
            },
          },
        ],
      },
    });
  });

  function traceInSpan(errorType?: string): ReadableSpan {
    trace.getTracer('test').startActiveSpan(SPAN_NAME, (span) => {
      traceToolCall({
        tool,
        args: {},
        functionResponseEvent: responseEvent,
        errorType,
      });
      span.end();
    });
    return exportedSpan();
  }

  it('should record the error type and fail the span', () => {
    const span = traceInSpan('TOOL_ERROR');

    expect(span.attributes['error.type']).toBe('TOOL_ERROR');
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'TOOL_ERROR',
    });
  });

  it('should leave the span successful when no error type is given', () => {
    const span = traceInSpan();

    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('should treat an empty error type as no error', () => {
    const span = traceInSpan('');

    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe('execute_tool span for a tool that reports an error in its response', () => {
  let invocationContext: InvocationContext;

  beforeEach(() => {
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager: new PluginManager(),
    });
  });

  async function runTool(
    response: Record<string, unknown>,
  ): Promise<ReadableSpan> {
    const tool = new InventoryTool(response);
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'fc_1', name: tool.name, args: {}}],
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    // The response handed back to the agent must be untouched by detection.
    expect(event?.content?.parts?.[0].functionResponse?.response).toEqual(
      response,
    );
    return exportedSpan();
  }

  it('marks the span as failed and records the detected error type', async () => {
    const span = await runTool({status: 'ERROR', detail: 'SKU not found'});

    expect(span.attributes['error.type']).toBe('TOOL_ERROR');
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'TOOL_ERROR',
    });
  });

  it('leaves the span of a successful call untouched', async () => {
    const span = await runTool({status: 'OK', count: 7});

    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });
});
