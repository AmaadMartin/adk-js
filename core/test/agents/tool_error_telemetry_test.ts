/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  BaseTool,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunAsyncToolRequest,
  ToolInputParameters,
  createSession,
  functionsExportedForTestingOnly,
} from '@google/adk';
import {SpanStatus, SpanStatusCode, context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {z} from 'zod/v3';
import {logger} from '../../src/utils/logger.js';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

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
});

/** The tool's span, which every assertion here reads. */
function recordedSpan(toolName: string): ReadableSpan {
  const spans = exporter
    .getFinishedSpans()
    .filter((span) => span.name === `execute_tool ${toolName}`);
  expect(spans).toHaveLength(1);
  return spans[0];
}

/** The `error.type` recorded on the tool's span, or `undefined`. */
function recordedErrorType(toolName: string): unknown {
  return recordedSpan(toolName).attributes['error.type'];
}

/** The status recorded on the tool's span. */
function recordedStatus(toolName: string): SpanStatus {
  return recordedSpan(toolName).status;
}

async function runTool(tool: BaseTool): Promise<unknown> {
  const event = await handleFunctionCallList({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      pluginManager: new PluginManager([]),
    }),
    functionCalls: [{id: 'fc-1', name: tool.name, args: {}}],
    toolsDict: {[tool.name]: tool},
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
  });
  return event?.content?.parts?.[0]?.functionResponse?.response;
}

/** A tool that reports its own failures, the way `MCPTool` does. */
class DetectingTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  override detectErrorInResponse(response: unknown): string | undefined {
    return typeof response === 'object' &&
      response !== null &&
      'error' in response
      ? 'DETECTED_ERROR'
      : undefined;
  }
}

/** A tool whose error detector throws, to prove telemetry cannot break a call. */
class BrokenDetectorTool extends FunctionTool {
  override detectErrorInResponse(): string | undefined {
    throw new Error('detector exploded');
  }
}

/** A tool that does not implement the error-detection hook. */
class PlainTool extends BaseTool {
  constructor() {
    super({name: 'plain_tool', description: 'Does one thing.'});
  }

  override async runAsync(_req: RunAsyncToolRequest): Promise<unknown> {
    return {error: 'undetected'};
  }
}

describe('tool error type telemetry', () => {
  it('records the detected error type when the tool returns an error', async () => {
    const tool = new DetectingTool({
      name: 'failing_tool',
      description: 'Always fails.',
      execute: () => ({error: 'not found'}),
    });

    expect(await runTool(tool)).toEqual({error: 'not found'});
    expect(recordedErrorType('failing_tool')).toBe('DETECTED_ERROR');
  });

  it('records nothing when the tool succeeds', async () => {
    const tool = new DetectingTool({
      name: 'happy_tool',
      description: 'Always works.',
      execute: () => ({result: 'ok'}),
    });

    await runTool(tool);

    expect(recordedErrorType('happy_tool')).toBeUndefined();
  });

  it('records nothing for a tool that does not detect its own errors', async () => {
    await runTool(new PlainTool());

    expect(recordedErrorType('plain_tool')).toBeUndefined();
  });

  it('swallows a throwing detector and still returns the tool result', async () => {
    // The detector is expected to fail here; keep its diagnostic out of the
    // suite output while still pinning that the failure is reported.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const tool = new BrokenDetectorTool({
      name: 'broken_detector_tool',
      description: 'Detects badly.',
      execute: () => ({error: 'not found'}),
    });

    expect(await runTool(tool)).toEqual({error: 'not found'});
    expect(recordedErrorType('broken_detector_tool')).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('records nothing while the tool waits for confirmation', async () => {
    const tool = new DetectingTool({
      name: 'gated_tool',
      description: 'Needs approval.',
      parameters: z.object({}),
      execute: () => ({result: 'ok'}),
      requireConfirmation: true,
    });

    const response = await runTool(tool);

    expect(response).toHaveProperty('error');
    expect(recordedErrorType('gated_tool')).toBeUndefined();
  });

  it('records nothing while the tool waits for credentials', async () => {
    const authConfig: AuthConfig = {
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Key'},
      credentialKey: 'test-key',
    };
    const tool = new DetectingTool({
      name: 'auth_tool',
      description: 'Needs a credential.',
      execute: (_input, toolContext) => {
        toolContext?.requestCredential(authConfig);
        return {error: 'credential required'};
      },
    });

    expect(await runTool(tool)).toEqual({error: 'credential required'});
    expect(recordedErrorType('auth_tool')).toBeUndefined();
  });

  it('fails the span when the tool returns an error', async () => {
    const tool = new DetectingTool({
      name: 'failed_span_tool',
      description: 'Always fails.',
      execute: () => ({error: 'not found'}),
    });

    await runTool(tool);

    expect(recordedStatus('failed_span_tool')).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'DETECTED_ERROR',
    });
  });

  it('leaves the span status unset when the tool succeeds', async () => {
    const tool = new DetectingTool({
      name: 'unset_status_tool',
      description: 'Always works.',
      execute: () => ({result: 'ok'}),
    });

    await runTool(tool);

    expect(recordedStatus('unset_status_tool').code).toBe(SpanStatusCode.UNSET);
  });
});
