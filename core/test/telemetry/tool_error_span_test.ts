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
  getLogger,
  InvocationContext,
  LlmAgent,
  Logger,
  PluginManager,
  RunAsyncToolRequest,
  Session,
} from '@google/adk';
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
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';

import {traceToolCall} from '../../src/telemetry/tracing.js';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

const OK_RESPONSE = {result: 'tool executed'};

function isErrorStatus(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    'status' in response &&
    response.status === 'ERROR'
  );
}

/** A tool that reports failures in its response rather than by throwing. */
class InventoryTool extends BaseTool {
  constructor(private readonly response: Record<string, unknown>) {
    super({name: 'inventoryTool', description: 'looks a SKU up'});
  }

  override async runAsync(): Promise<unknown> {
    return this.response;
  }

  override detectErrorInResponse(response: unknown): string | undefined {
    return isErrorStatus(response) ? 'TOOL_ERROR' : undefined;
  }
}

/** A tool that declares no detector at all. */
class PlainTool extends BaseTool {
  constructor() {
    super({name: 'plainTool', description: 'declares no detector'});
  }

  override async runAsync(): Promise<unknown> {
    return OK_RESPONSE;
  }
}

/** A tool whose response is a control signal, not a failure. */
class ControlSignalTool extends BaseTool {
  constructor(private readonly signal: 'confirm' | 'auth') {
    super({name: `${signal}Tool`, description: 'requests a control signal'});
  }

  override async runAsync({
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    if (this.signal === 'confirm') {
      toolContext.requestConfirmation({hint: 'Authorize execution?'});
    } else {
      toolContext.requestCredential({
        credentialKey: 'bearer-credential',
        authScheme: {type: 'http', scheme: 'bearer'},
      });
    }
    return CONTROL_SIGNAL_RESPONSE;
  }

  override detectErrorInResponse(response: unknown): string | undefined {
    return isErrorStatus(response) ? 'TOOL_ERROR' : undefined;
  }
}

const CONTROL_SIGNAL_RESPONSE = {
  status: 'ERROR',
  message: 'This tool requires user approval.',
};

/** A tool whose detector is buggy and raises. */
class ExplodingDetectorTool extends BaseTool {
  constructor() {
    super({name: 'explodingDetectorTool', description: 'buggy detector'});
  }

  override async runAsync(): Promise<unknown> {
    return OK_RESPONSE;
  }

  override detectErrorInResponse(): string | undefined {
    throw new Error('detection exploded');
  }
}

/**
 * An untyped JavaScript tool whose detector hands back something that is not
 * an error label. `JSON.parse` is what produces the `any` here: the declared
 * hook signature cannot stop a plain JavaScript tool returning a number, which
 * is exactly the case this fixture exists to cover.
 */
class NonStringDetectorTool extends BaseTool {
  constructor() {
    super({name: 'nonStringDetectorTool', description: 'untyped detector'});
  }

  override async runAsync(): Promise<unknown> {
    return {status: 'ERROR'};
  }

  override detectErrorInResponse(): string | undefined {
    return JSON.parse('500');
  }
}

// Spans are recorded for real rather than stubbed, so these assertions pin
// what an operator would actually see in an exported trace.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

function exportedSpan(toolName: string): ReadableSpan {
  const name = `execute_tool ${toolName}`;
  const span = exporter
    .getFinishedSpans()
    .find((finished) => finished.name === name);
  if (!span) {
    expect.fail(`no ${name} span was exported`);
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
    trace
      .getTracer('test')
      .startActiveSpan(`execute_tool ${tool.name}`, (span) => {
        traceToolCall({
          tool,
          args: {},
          functionResponseEvent: responseEvent,
          errorType,
        });
        span.end();
      });
    return exportedSpan(tool.name);
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

describe('execute_tool span for a tool that classifies its own response', () => {
  let invocationContext: InvocationContext;
  let loggerErrorSpy: MockInstance<Logger['error']>;

  beforeEach(() => {
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager: new PluginManager(),
    });
    loggerErrorSpy = vi
      .spyOn(getLogger(), 'error')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  async function runTool(
    tool: BaseTool,
    expectedResponse: Record<string, unknown>,
  ): Promise<ReadableSpan> {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'fc_1', name: tool.name, args: {}}],
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    // The response handed back to the agent must be untouched by detection.
    expect(event?.content?.parts?.[0].functionResponse?.response).toEqual(
      expectedResponse,
    );
    return exportedSpan(tool.name);
  }

  it('marks the span as failed and records the detected error type', async () => {
    const response = {status: 'ERROR', detail: 'SKU not found'};

    const span = await runTool(new InventoryTool(response), response);

    expect(span.attributes['error.type']).toBe('TOOL_ERROR');
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'TOOL_ERROR',
    });
  });

  it('leaves the span of a successful call untouched', async () => {
    const response = {status: 'OK', count: 7};

    const span = await runTool(new InventoryTool(response), response);

    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records no error type for a tool that declares no detector', async () => {
    const span = await runTool(new PlainTool(), OK_RESPONSE);

    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('skips detection while the tool is requesting confirmation', async () => {
    const span = await runTool(
      new ControlSignalTool('confirm'),
      CONTROL_SIGNAL_RESPONSE,
    );

    expect(span.attributes).not.toHaveProperty('error.type');
  });

  it('skips detection while the tool is requesting auth', async () => {
    const span = await runTool(
      new ControlSignalTool('auth'),
      CONTROL_SIGNAL_RESPONSE,
    );

    expect(span.attributes).not.toHaveProperty('error.type');
  });

  it('swallows and logs a detector that throws', async () => {
    const span = await runTool(new ExplodingDetectorTool(), OK_RESPONSE);

    expect(span.attributes).not.toHaveProperty('error.type');
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Error detecting error type for telemetry from tool explodingDetectorTool.',
      expect.any(Error),
    );
  });

  it('ignores a detector result that is not an error label', async () => {
    const span = await runTool(new NonStringDetectorTool(), {status: 'ERROR'});

    expect(span.attributes).not.toHaveProperty('error.type');
  });
});
