/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  BaseTool,
  Context,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunAsyncToolRequest,
  ToolResponseErrorType,
  createSession,
  functionsExportedForTestingOnly,
} from '@google/adk';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
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

/** The `error.type` recorded on the tool's span, or `undefined`. */
function recordedErrorType(toolName: string): unknown {
  const spans = exporter
    .getFinishedSpans()
    .filter((span) => span.name === `execute_tool ${toolName}`);
  expect(spans).toHaveLength(1);
  return spans[0].attributes['error.type'];
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
  it('records TOOL_ERROR when the tool returns an error', async () => {
    const tool = new FunctionTool({
      name: 'failing_tool',
      description: 'Always fails.',
      execute: () => ({error: 'not found'}),
    });

    expect(await runTool(tool)).toEqual({error: 'not found'});
    expect(recordedErrorType('failing_tool')).toBe(
      ToolResponseErrorType.TOOL_ERROR,
    );
  });

  it('records nothing when the tool succeeds', async () => {
    const tool = new FunctionTool({
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
    const tool = new FunctionTool({
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
    const authConfig = {
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Key'},
    } as AuthConfig;
    const tool = new FunctionTool({
      name: 'auth_tool',
      description: 'Needs a credential.',
      execute: (_input: string, toolContext?: Context) => {
        toolContext?.requestCredential(authConfig);
        return {error: 'credential required'};
      },
    });

    expect(await runTool(tool)).toEqual({error: 'credential required'});
    expect(recordedErrorType('auth_tool')).toBeUndefined();
  });
});
