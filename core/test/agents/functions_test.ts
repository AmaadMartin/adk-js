/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  Context,
  Event,
  Session,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
} from '@google/adk';
import {
  BasePlugin,
  BaseTool,
  createEvent,
  createEventActions,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  isToolNotFound,
  LlmAgent,
  LongRunningFunctionTool,
  PluginManager,
  ToolConfirmation,
} from '@google/adk';
import type {FunctionCall, FunctionResponse} from '@google/genai';
import {createPartFromBase64, createPartFromUri} from '@google/genai';
import type {MockInstance} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  findEventByFunctionCallId,
  findMatchingFunctionCall,
  generateClientFunctionCallId,
  mergeParallelFunctionResponseEvents,
} from '../../src/agents/functions.js';
import * as metrics from '../../src/telemetry/metrics.js';
import {logger} from '../../src/utils/logger.js';

// Get the test target function
const {handleFunctionCallList, generateRequestConfirmationEvent} =
  functionsExportedForTestingOnly;

// Tool for testing
const testTool = new FunctionTool({
  name: 'testTool',
  description: 'test tool',
  parameters: z.object({}),
  execute: async () => {
    return {result: 'tool executed'};
  },
});

const errorTool = new FunctionTool({
  name: 'errorTool',
  description: 'error tool',
  parameters: z.object({}),
  execute: async () => {
    throw new Error('tool error message content');
  },
});

const DEFERRING_TOOL_NAME = 'deferringTool';

/**
 * A tool whose matching `FunctionResponse` is supplied elsewhere. Only
 * `BaseTool` carries `defersResponse`, so the fixture cannot be a
 * `FunctionTool`.
 */
class DeferringTool extends BaseTool {
  override readonly defersResponse = true;

  private readonly response: unknown;

  constructor(response: unknown) {
    super({name: DEFERRING_TOOL_NAME, description: 'defers its response'});
    this.response = response;
  }

  override async runAsync(): Promise<unknown> {
    return this.response;
  }
}

function deferringCall(): FunctionCall {
  return {
    id: randomIdForTestingOnly(),
    name: DEFERRING_TOOL_NAME,
    args: {},
  };
}

// Plugin for testing
class TestPlugin extends BasePlugin {
  beforeToolCallbackResponse?: Record<string, unknown>;
  afterToolCallbackResponse?: Record<string, unknown>;
  onToolErrorCallbackResponse?: Record<string, unknown>;

  override async beforeToolCallback(
    ..._args: Parameters<BasePlugin['beforeToolCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.beforeToolCallbackResponse) {
      return this.beforeToolCallbackResponse;
    }
    return undefined;
  }

  override async afterToolCallback(
    ..._args: Parameters<BasePlugin['afterToolCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.afterToolCallbackResponse) {
      return this.afterToolCallbackResponse;
    }
    return undefined;
  }

  override async onToolErrorCallback(
    ..._args: Parameters<BasePlugin['onToolErrorCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.onToolErrorCallbackResponse) {
      return this.onToolErrorCallbackResponse;
    }
    return undefined;
  }
}

/** Records the parameters `onToolErrorCallback` was called with. */
class RecordingErrorPlugin extends TestPlugin {
  capturedParams?: Parameters<BasePlugin['onToolErrorCallback']>[0];

  override async onToolErrorCallback(
    params: Parameters<BasePlugin['onToolErrorCallback']>[0],
  ): Promise<Record<string, unknown> | undefined> {
    this.capturedParams = params;
    return this.onToolErrorCallbackResponse;
  }
}

function randomIdForTestingOnly(): string {
  return (Math.random() * 100).toString();
}

const silentLongRunningTool = new FunctionTool({
  name: 'silentLongRunningTool',
  description: 'long running tool returning nullish',
  parameters: z.object({}),
  execute: async () => null,
  isLongRunning: true,
});

const falsyLongRunningTool = new FunctionTool({
  name: 'falsyLongRunningTool',
  description: 'long running tool returning an empty string',
  parameters: z.object({}),
  execute: async () => '',
  isLongRunning: true,
});

/** Returned by reference so a test can pin the payload it becomes. */
const INVENTORY = new Map([['widgets', 12]]);

const mapTool = new FunctionTool({
  name: 'mapTool',
  description: 'returns a Map',
  parameters: z.object({}),
  execute: async () => INVENTORY,
});

const setTool = new FunctionTool({
  name: 'setTool',
  description: 'returns a Set',
  parameters: z.object({}),
  execute: async () => new Set([1, 2]),
});

const dateTool = new FunctionTool({
  name: 'dateTool',
  description: 'returns a Date',
  parameters: z.object({}),
  execute: async () => new Date(0),
});

function callFor(tool: BaseTool): FunctionCall {
  return {id: randomIdForTestingOnly(), name: tool.name, args: {}};
}

const CHART_DATA = 'Y2hhcnQtYnl0ZXM=';
const PHOTO_DATA = 'cGhvdG8tYnl0ZXM=';
const CHART_URI = 'gs://bucket/chart.png';

const chartPart = createPartFromBase64(CHART_DATA, 'image/png');
const photoPart = createPartFromBase64(PHOTO_DATA, 'image/jpeg');
const fileChartPart = createPartFromUri(CHART_URI, 'image/png');

const chartResponsePart = {
  inlineData: {data: CHART_DATA, mimeType: 'image/png'},
};
const photoResponsePart = {
  inlineData: {data: PHOTO_DATA, mimeType: 'image/jpeg'},
};

/**
 * Builds a long-running tool that mutates its tool context and then returns no
 * response.
 */
function createStartJobTool(mutate: (toolContext: Context) => void) {
  return new LongRunningFunctionTool({
    name: 'startJob',
    description: 'starts a background job',
    parameters: z.object({}),
    execute: async (_args, toolContext) => {
      mutate(toolContext!);
      return undefined;
    },
  });
}

describe('handleFunctionCallList', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;
  let functionCall: FunctionCall;
  let toolsDict: Record<string, BaseTool>;
  let warnSpy: MockInstance<typeof logger.warn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // These tests deliberately provoke resolution failures; keep the expected
    // diagnostics out of the suite output.
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
    functionCall = {
      id: randomIdForTestingOnly(),
      name: 'testTool',
      args: {},
    };
    toolsDict = {'testTool': testTool};
  });

  it('should execute tool with no callbacks or plugins', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'tool executed',
    });
  });

  it('records the execution duration of a tool that succeeds', async () => {
    const spy = vi.spyOn(metrics, 'recordToolExecutionDuration').mockClear();

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(spy).toHaveBeenCalledWith(
      'testTool',
      'FunctionTool',
      'test_agent',
      expect.any(Number),
      undefined,
    );
  });

  it('should wrap array responses into a {results: array} object', async () => {
    const arrayTool = new FunctionTool({
      name: 'arrayTool',
      description: 'returns array',
      parameters: z.object({}),
      execute: async () => {
        return ['item1', 'item2'];
      },
    });

    const arrayFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'arrayTool',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [arrayFunctionCall],
      toolsDict: {'arrayTool': arrayTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      results: ['item1', 'item2'],
    });
  });

  it('should execute beforeToolCallback and return its result', async () => {
    const beforeToolCallback: SingleBeforeToolCallback = async () => {
      return {result: 'beforeToolCallback executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [beforeToolCallback],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'beforeToolCallback executed',
    });
  });

  it('should execute second beforeToolCallback if first returns undefined', async () => {
    const beforeToolCallback1: SingleBeforeToolCallback = async () => {
      return undefined;
    };
    const beforeToolCallback2: SingleBeforeToolCallback = async () => {
      return {result: 'beforeToolCallback2 executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [beforeToolCallback1, beforeToolCallback2],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'beforeToolCallback2 executed',
    });
  });

  it('should execute afterToolCallback and return its result', async () => {
    const afterToolCallback: SingleAfterToolCallback = async () => {
      return {result: 'afterToolCallback executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [afterToolCallback],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'afterToolCallback executed',
    });
  });

  it('should execute second afterToolCallback if first returns undefined', async () => {
    const afterToolCallback1: SingleAfterToolCallback = async () => {
      return undefined;
    };
    const afterToolCallback2: SingleAfterToolCallback = async () => {
      return {result: 'afterToolCallback2 executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [afterToolCallback1, afterToolCallback2],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'afterToolCallback2 executed',
    });
  });

  it('should execute plugin beforeToolCallback and return its result', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.beforeToolCallbackResponse = {
      result: 'plugin beforeToolCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'plugin beforeToolCallback executed',
    });
  });

  it('should execute plugin afterToolCallback and return its result', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.afterToolCallbackResponse = {
      result: 'plugin afterToolCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'plugin afterToolCallback executed',
    });
  });

  it('should call plugin onToolErrorCallback when tool throws', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {
      result: 'onToolErrorCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const errorFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'errorTool',
      args: {},
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [errorFunctionCall],
      toolsDict: {'errorTool': errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'onToolErrorCallback executed',
    });
  });

  it('should return error message when error is thrown during tool execution, when no plugin onToolErrorCallback is provided', async () => {
    const errorFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'errorTool',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [errorFunctionCall],
      toolsDict: {'errorTool': errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      error: "Error in tool 'errorTool': tool error message content",
    });
  });

  it('records the error type of a tool that throws', async () => {
    const spy = vi.spyOn(metrics, 'recordToolExecutionDuration').mockClear();
    const errorFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'errorTool',
      args: {},
    };

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [errorFunctionCall],
      toolsDict: {'errorTool': errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(spy).toHaveBeenCalledWith(
      'errorTool',
      'FunctionTool',
      'test_agent',
      expect.any(Number),
      expect.any(Error),
    );
  });

  it('should route an unregistered tool name through plugin onToolErrorCallback', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {
      error: 'no such tool, try testTool',
    };
    pluginManager.registerPlugin(plugin);
    const onToolErrorCallback = vi.spyOn(plugin, 'onToolErrorCallback');
    const hallucinatedCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'google_search',
      args: {query: 'anything'},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [hallucinatedCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(onToolErrorCallback).toHaveBeenCalledTimes(1);
    const {tool, toolArgs} = onToolErrorCallback.mock.calls[0][0];
    expect(tool.name).toBe('google_search');
    expect(toolArgs).toEqual({query: 'anything'});

    const functionResponse = event!.content!.parts![0].functionResponse!;
    expect(functionResponse.id).toBe(hallucinatedCall.id);
    expect(functionResponse.name).toBe('google_search');
    expect(functionResponse.response).toEqual({
      error: 'no such tool, try testTool',
    });
  });

  it('should answer an unregistered tool name with the resolution error when no plugin handles it', async () => {
    const unresolvableCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'google_search',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [unresolvableCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // The call has to be answered, not left dangling: the request is otherwise
    // identical next iteration, and Gemini rejects an unpaired functionCall.
    const functionResponse = event!.content!.parts![0].functionResponse!;
    expect(functionResponse.id).toBe(unresolvableCall.id);
    expect(functionResponse.name).toBe('google_search');
    const {error} = functionResponse.response as {error: string};
    expect(error).toContain(
      'Function google_search is not found in the toolsDict.',
    );
    // The inventory and the causes are for an operator, not the model: the
    // model already has its declarations and would otherwise pay for the whole
    // toolset on every occurrence.
    expect(error).not.toContain('Callable tools');
    expect(error).not.toContain('Possible causes');
  });

  it('should warn the operator with the inventory and the possible causes', async () => {
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name: 'google_search', args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // Without this the only trace of a misconfigured agent is a string the
    // model sees and the operator never does.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = warnSpy.mock.calls[0][0] as string;
    expect(warning).toContain("Could not resolve tool 'google_search'");
    expect(warning).toContain('call-1');
    expect(warning).toContain('Callable tools: testTool.');
    expect(warning).toContain('Possible causes:');
    // The cause this change tripped over in SleepyTool has to be listed.
    expect(warning).toContain('_getDeclaration()');
  });

  it('should not warn when a plugin handles the unresolvable call', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {result: 'handled'};
    pluginManager.registerPlugin(plugin);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name: 'google_search', args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // A plugin that answers these has made them an expected condition; the
    // sibling path for a registered tool that throws is silent too.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should skip the before and after tool callbacks for an unresolvable call', async () => {
    const plugin = new TestPlugin('testPlugin');
    pluginManager.registerPlugin(plugin);
    const beforeToolCallback = vi.spyOn(plugin, 'beforeToolCallback');
    const afterToolCallback = vi.spyOn(plugin, 'afterToolCallback');
    const canonicalAfter = vi.fn().mockResolvedValue(undefined);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name: 'google_search', args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [canonicalAfter],
    });

    // Documented asymmetry with the registered-tool error path, which does run
    // them. Pin it so the doc comment and the code cannot drift apart.
    expect(beforeToolCallback).not.toHaveBeenCalled();
    expect(afterToolCallback).not.toHaveBeenCalled();
    expect(canonicalAfter).not.toHaveBeenCalled();
  });

  it('should hand plugins a placeholder that identifies itself and rethrows', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {result: 'handled'};
    pluginManager.registerPlugin(plugin);
    const onToolErrorCallback = vi.spyOn(plugin, 'onToolErrorCallback');

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name: 'google_search', args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const {tool} = onToolErrorCallback.mock.calls[0][0];
    // A plugin can tell an unresolvable name from a registered tool that threw
    // without matching on the error message.
    expect(isToolNotFound(tool)).toBe(true);
    expect(isToolNotFound(testTool)).toBe(false);
    // Nothing in the framework runs it, but a plugin holding it can, and it
    // must not invent a second, different message.
    await expect(
      tool.runAsync({args: {}, toolContext: {} as Context}),
    ).rejects.toThrow('Function google_search is not found in the toolsDict.');
  });

  // `functionCall.name` is model-supplied and `toolsDict` is a plain object, so
  // an unguarded lookup reaches `Object.prototype`. These names would resolve
  // to a JS builtin, be treated as found, and skip the whole recovery path —
  // `constructor` even answers under the name `Object`, breaking the pairing.
  it.each([
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
  ])('should treat the inherited name %s as unresolvable', async (name) => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-1', name, args: {}}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const functionResponse = event!.content!.parts![0].functionResponse!;
    // The response has to name the call, or the pair dangles.
    expect(functionResponse.name).toBe(name);
    expect(functionResponse.id).toBe('call-1');
    expect((functionResponse.response as {error: string}).error).toBe(
      `Function ${name} is not found in the toolsDict.`,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('should answer every call in a batch when one name is unresolvable', async () => {
    const unresolvableId = randomIdForTestingOnly();
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        callFor(testTool),
        {id: unresolvableId, name: 'google_search', args: {}},
        callFor(testTool),
      ],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const responses = event!.content!.parts!.map((p) => p.functionResponse!);
    expect(responses.map((r) => r.name)).toEqual([
      'testTool',
      'google_search',
      'testTool',
    ]);
    expect(responses[0].response).toEqual({result: 'tool executed'});
    expect(responses[2].response).toEqual({result: 'tool executed'});
    // The id is what keeps the pairing balanced, so pin it on the
    // unresolvable slot too — that is the one built off the placeholder.
    expect(responses[1].id).toBe(unresolvableId);
    expect(responses[1].response).toHaveProperty('error');
  });

  it('should pass abortSignal to tool execution', async () => {
    const abortController = new AbortController();
    const signal = abortController.signal;

    const mockTool = new FunctionTool({
      name: 'mockTool',
      description: 'mock tool',
      parameters: z.object({}),
      execute: async () => ({result: 'ok'}),
    });

    const runAsyncSpy = vi.spyOn(mockTool, 'runAsync');
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager,
      abortSignal: signal,
    });

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: '1', name: 'mockTool', args: {}}],
      toolsDict: {'mockTool': mockTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(runAsyncSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {},
        toolContext: expect.objectContaining({
          abortSignal: signal,
        }),
      }),
    );
  });

  it('should still emit an event when a regular tool returns nothing', async () => {
    const nullTool = new FunctionTool({
      name: 'nullTool',
      description: 'tool returning nullish',
      parameters: z.object({}),
      execute: async () => null,
    });
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(nullTool)],
      toolsDict: {'nullTool': nullTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    expect(event?.content?.parts?.[0].functionResponse?.response).toStrictEqual(
      {
        result: null,
      },
    );
  });

  it('should cleanly return null and emit no event when long-running tool returns null or undefined', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(silentLongRunningTool)],
      toolsDict: {silentLongRunningTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).toBeNull();
  });

  it('should emit a response part only for the long-running tool that returned something', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        callFor(silentLongRunningTool),
        callFor(falsyLongRunningTool),
      ],
      toolsDict: {silentLongRunningTool, falsyLongRunningTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event?.content?.parts).toEqual([
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          name: 'falsyLongRunningTool',
          response: {result: ''},
        }),
      }),
    ]);
  });

  it.each([
    [
      'a stateDelta',
      (toolContext: Context) => {
        toolContext.state.set('jobStarted', true);
      },
      {stateDelta: {jobStarted: true}},
    ],
    [
      'skipSummarization',
      (toolContext: Context) => {
        toolContext.actions.skipSummarization = true;
      },
      {skipSummarization: true},
    ],
    [
      'transferToAgent',
      (toolContext: Context) => {
        toolContext.actions.transferToAgent = 'other_agent';
      },
      {transferToAgent: 'other_agent'},
    ],
    [
      'a requested tool confirmation',
      (toolContext: Context) => {
        toolContext.requestConfirmation({hint: 'ok?'});
      },
      {
        requestedToolConfirmations: {
          'lro_1': new ToolConfirmation({hint: 'ok?', confirmed: false}),
        },
      },
    ],
  ])(
    'should emit a content-less event carrying %s',
    async (_label, mutate, expectedActions) => {
      const event = await handleFunctionCallList({
        invocationContext,
        functionCalls: [{id: 'lro_1', name: 'startJob', args: {}}],
        toolsDict: {'startJob': createStartJobTool(mutate)},
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });

      expect(event!.content).toBeUndefined();
      expect(event!.actions).toMatchObject(expectedActions);
      expect(event!.author).toBe('test_agent');
      expect(event!.invocationId).toBe('inv_123');
    },
  );

  it('should merge the actions of a silent long running tool into the batch event', async () => {
    const startJob = createStartJobTool((toolContext) => {
      toolContext.state.set('jobStarted', true);
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(startJob), callFor(testTool)],
      toolsDict: {startJob, testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts!.length).toBe(1);
    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      result: 'tool executed',
    });
    expect(event!.actions.stateDelta).toEqual({jobStarted: true});
  });

  it('should keep the function response of a long running tool that does respond', async () => {
    const startJob = new LongRunningFunctionTool({
      name: 'startJob',
      description: 'starts a background job',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        toolContext!.state.set('jobStarted', true);
        return {status: 'pending'};
      },
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(startJob)],
      toolsDict: {startJob},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      status: 'pending',
    });
    expect(event!.actions.stateDelta).toEqual({jobStarted: true});
  });

  async function responseFor(
    tool: BaseTool,
    afterToolCallbacks: SingleAfterToolCallback[] = [],
  ): Promise<FunctionResponse> {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(tool)],
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks,
    });
    const functionResponse = event?.content?.parts?.[0].functionResponse;
    if (!functionResponse) {
      expect.fail('the tool call emitted no function response');
    }
    return functionResponse;
  }

  function mediaTool(name: string, execute: () => unknown) {
    return new FunctionTool({
      name,
      description: 'returns media',
      parameters: z.object({}),
      execute: async () => execute(),
    });
  }

  it('should carry a bare media part on the function response', async () => {
    const tool = mediaTool('chartTool', () => chartPart);

    const response = await responseFor(tool);

    expect(response.parts).toEqual([chartResponsePart]);
    expect(response.response).toEqual({});
  });

  it('should carry media returned alongside data', async () => {
    const tool = mediaTool('chartTool', () => ({
      chart: chartPart,
      summary: 'up 3%',
    }));

    const response = await responseFor(tool);

    expect(response.parts).toEqual([chartResponsePart]);
    expect(response.response).toEqual({summary: 'up 3%'});
  });

  it('should carry several media parts in the order the tool returned them', async () => {
    const tool = mediaTool('chartTool', () => [
      chartPart,
      photoPart,
      'two charts',
    ]);

    const response = await responseFor(tool);

    expect(response.parts).toEqual([chartResponsePart, photoResponsePart]);
    expect(response.response).toEqual({results: ['two charts']});
  });

  it('should carry a file reference as a media part', async () => {
    const tool = mediaTool('chartTool', () => fileChartPart);

    const response = await responseFor(tool);

    expect(response.parts).toEqual([
      {fileData: {fileUri: CHART_URI, mimeType: 'image/png'}},
    ]);
    expect(response.response).toEqual({});
  });

  it('should leave a file reference without a mime type in the response body', async () => {
    const value = {fileData: {fileUri: CHART_URI}};
    const tool = mediaTool('chartTool', () => value);

    const response = await responseFor(tool);

    expect(response.parts).toBeUndefined();
    expect(response.response).toEqual(value);
  });

  it('should carry media nested one container deep and drop the emptied key', async () => {
    const tool = mediaTool('chartTool', () => ({
      images: [chartPart, photoPart],
      summary: 'two charts',
    }));

    const response = await responseFor(tool);

    expect(response.parts).toEqual([chartResponsePart, photoResponsePart]);
    expect(response.response).toEqual({summary: 'two charts'});
  });

  it('should leave media buried deeper than one container in the response body', async () => {
    const value = {report: {charts: {first: chartPart}}};
    const tool = mediaTool('chartTool', () => value);

    const response = await responseFor(tool);

    expect(response.parts).toBeUndefined();
    expect(response.response).toEqual(value);
  });

  it('should leave a plain data result unchanged', async () => {
    const tool = mediaTool('chartTool', () => ({summary: 'up 3%'}));

    const response = await responseFor(tool);

    expect(response.parts).toBeUndefined();
    expect(response.response).toEqual({summary: 'up 3%'});
  });

  it('should emit no parts key at all for a media-free result', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const functionResponse = event?.content?.parts?.[0].functionResponse;
    expect(functionResponse).toStrictEqual({
      id: functionCall.id,
      name: 'testTool',
      response: {result: 'tool executed'},
    });
    expect('parts' in functionResponse!).toBe(false);
  });

  it('should keep the media parts of one call when parallel calls are merged', async () => {
    const chartTool = mediaTool('chartTool', () => chartPart);
    const chartCall = callFor(chartTool);
    const plainCall = callFor(testTool);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [chartCall, plainCall],
      toolsDict: {chartTool, testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event?.content?.parts?.[0].functionResponse).toStrictEqual({
      id: chartCall.id,
      name: 'chartTool',
      response: {},
      parts: [chartResponsePart],
    });
    expect(event?.content?.parts?.[1].functionResponse).toStrictEqual({
      id: plainCall.id,
      name: 'testTool',
      response: {result: 'tool executed'},
    });
  });

  it('should carry media returned by an afterToolCallback', async () => {
    const response = await responseFor(testTool, [
      () => ({chart: chartPart, summary: 'up 3%'}),
    ]);

    expect(response.parts).toEqual([chartResponsePart]);
    expect(response.response).toEqual({summary: 'up 3%'});
  });

  it('should answer an unknown tool with the lookup error when no plugin handles it', async () => {
    const unknownCall = {
      id: randomIdForTestingOnly(),
      name: 'unknownTool',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [unknownCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // The call is answered rather than thrown: an unanswered call makes the
    // next request identical to this one and the model re-issues it.
    const functionResponse = event!.content!.parts![0].functionResponse!;
    expect(functionResponse.id).toBe(unknownCall.id);
    expect(functionResponse.name).toBe('unknownTool');
    expect(functionResponse.response).toEqual({
      error: 'Function unknownTool is not found in the toolsDict.',
    });
  });

  it('should answer an unknown tool with the onToolErrorCallback response', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {reflection: 'use "testTool"'};
    pluginManager.registerPlugin(plugin);
    const unknownCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'unknownTool',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [unknownCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const functionResponse = event?.content?.parts?.[0].functionResponse;
    expect(functionResponse?.response).toEqual({reflection: 'use "testTool"'});
    expect(functionResponse?.name).toBe('unknownTool');
    expect(functionResponse?.id).toBe(unknownCall.id);
  });

  it('should hand a placeholder tool and the lookup error to the callback', async () => {
    const plugin = new RecordingErrorPlugin('recordingPlugin');
    plugin.onToolErrorCallbackResponse = {reflection: 'use "testTool"'};
    pluginManager.registerPlugin(plugin);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: randomIdForTestingOnly(), name: 'unknownTool', args: {x: 1}},
      ],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const captured = plugin.capturedParams;
    if (!captured) {
      expect.fail('onToolErrorCallback was not called');
    }
    expect(captured.tool.name).toBe('unknownTool');
    expect(captured.tool.description).toBe('Tool not found');
    expect(captured.tool.isLongRunning).toBe(false);
    expect(captured.toolArgs).toEqual({x: 1});
    expect(captured.error.message).toBe(
      'Function unknownTool is not found in the toolsDict.',
    );
  });

  it('should refuse to run the placeholder handed to the callback', async () => {
    const plugin = new RecordingErrorPlugin('recordingPlugin');
    plugin.onToolErrorCallbackResponse = {reflection: 'use "testTool"'};
    pluginManager.registerPlugin(plugin);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: randomIdForTestingOnly(), name: 'unknownTool', args: {}},
      ],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const captured = plugin.capturedParams;
    if (!captured) {
      expect.fail('onToolErrorCallback was not called');
    }
    await expect(
      captured.tool.runAsync({args: {}, toolContext: captured.toolContext}),
    ).rejects.toThrow('Function unknownTool is not found in the toolsDict.');
  });

  it('should name the placeholder <unnamed> for a nameless function call', async () => {
    const plugin = new RecordingErrorPlugin('recordingPlugin');
    plugin.onToolErrorCallbackResponse = {reflection: 'name a tool'};
    pluginManager.registerPlugin(plugin);

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: randomIdForTestingOnly()}],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(plugin.capturedParams?.tool.name).toBe('<unnamed>');
    expect(plugin.capturedParams?.toolArgs).toEqual({});
  });

  it('should skip the after-tool callbacks for an unknown tool', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {reflection: 'use "testTool"'};
    plugin.afterToolCallbackResponse = {result: 'plugin override'};
    pluginManager.registerPlugin(plugin);
    const afterToolCallback = vi.fn<SingleAfterToolCallback>(async () => ({
      result: 'canonical override',
    }));

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: randomIdForTestingOnly(), name: 'unknownTool', args: {}},
      ],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [afterToolCallback],
    });

    expect(event?.content?.parts?.[0].functionResponse?.response).toEqual({
      reflection: 'use "testTool"',
    });
    expect(afterToolCallback).not.toHaveBeenCalled();
  });

  it('should still run a known tool called alongside an unknown one', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {reflection: 'use "testTool"'};
    pluginManager.registerPlugin(plugin);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        functionCall,
        {id: randomIdForTestingOnly(), name: 'unknownTool', args: {}},
      ],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event?.content?.parts).toEqual([
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          name: 'testTool',
          response: {result: 'tool executed'},
        }),
      }),
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          name: 'unknownTool',
          response: {reflection: 'use "testTool"'},
        }),
      }),
    ]);
  });

  it('should warn once and name the tool when a tool returns a Map', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(mapTool)],
      toolsDict: {mapTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mapTool'));
    warnSpy.mockRestore();
  });

  it('should leave the payload of a Map response untouched', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(mapTool)],
      toolsDict: {mapTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(event?.content?.parts?.[0].functionResponse?.response).toBe(
      INVENTORY,
    );
    warnSpy.mockRestore();
  });

  it('should warn once when a tool returns a Set', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(setTool)],
      toolsDict: {setTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('setTool'));
    warnSpy.mockRestore();
  });

  it('should warn once when a beforeToolCallback supplies a Map under a key', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const beforeToolCallback: SingleBeforeToolCallback = async () => {
      return {stock: new Map([['widgets', 12]])};
    };
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [beforeToolCallback],
      afterToolCallbacks: [],
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('testTool'));
    warnSpy.mockRestore();
  });

  it('should not warn when a tool returns a plain object', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should not warn when a tool returns an array', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const arrayTool = new FunctionTool({
      name: 'arrayTool',
      description: 'returns array',
      parameters: z.object({}),
      execute: async () => ['item1', 'item2'],
    });
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(arrayTool)],
      toolsDict: {arrayTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should not warn when a tool returns null', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const nullTool = new FunctionTool({
      name: 'nullTool',
      description: 'tool returning nullish',
      parameters: z.object({}),
      execute: async () => null,
    });
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(nullTool)],
      toolsDict: {nullTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should not warn when a tool throws', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(errorTool)],
      toolsDict: {errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should not warn when a tool returns a Date', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [callFor(dateTool)],
      toolsDict: {dateTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should emit no event when a deferring tool returns null', async () => {
    const deferringTool = new DeferringTool(null);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [deferringCall()],
      toolsDict: {[DEFERRING_TOOL_NAME]: deferringTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).toBeNull();
  });

  it('should emit no event when a deferring tool returns undefined', async () => {
    const deferringTool = new DeferringTool(undefined);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [deferringCall()],
      toolsDict: {[DEFERRING_TOOL_NAME]: deferringTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).toBeNull();
  });

  it('should emit an event when a deferring tool returns a response', async () => {
    const deferringTool = new DeferringTool({status: 'ok'});

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [deferringCall()],
      toolsDict: {[DEFERRING_TOOL_NAME]: deferringTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      status: 'ok',
    });
  });

  it('should emit an event for a tool that returns nothing without deferring', async () => {
    const quietTool = new FunctionTool({
      name: 'quietTool',
      description: 'returns nothing',
      parameters: z.object({}),
      execute: async () => null,
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: randomIdForTestingOnly(), name: 'quietTool', args: {}},
      ],
      toolsDict: {'quietTool': quietTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: null,
    });
  });

  it('should drop only the deferred call when merging parallel calls', async () => {
    const deferringTool = new DeferringTool(null);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [deferringCall(), functionCall],
      toolsDict: {[DEFERRING_TOOL_NAME]: deferringTool, ...toolsDict},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts).toHaveLength(1);
    expect(definedEvent.content!.parts![0].functionResponse!.name).toBe(
      'testTool',
    );
  });
});

describe('generateRequestConfirmationEvent', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;

  beforeEach(() => {
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
  });

  it('should return undefined if no requestedToolConfirmations', () => {
    const functionCallEvent = createEvent({content: {role: 'user', parts: []}});
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });
    expect(event).toBeUndefined();
  });

  it('should return undefined if requestedToolConfirmations is empty', () => {
    const functionCallEvent = createEvent({content: {role: 'user', parts: []}});
    const functionResponseEvent = createEvent({
      actions: createEventActions({requestedToolConfirmations: {}}),
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });
    expect(event).toBeUndefined();
  });

  it('should return confirmation event if requestedToolConfirmations is present', () => {
    const functionCallEvent = createEvent({
      content: {
        role: 'user',
        parts: [
          {
            functionCall: {
              name: 'tool_1',
              args: {arg: 'val1'},
              id: 'call_1',
            },
          },
          {
            functionCall: {
              name: 'tool_2',
              args: {arg: 'val2'},
              id: 'call_2',
            },
          },
        ],
      },
    });

    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          'call_1': new ToolConfirmation({
            hint: 'confirm tool 1',
            confirmed: false,
          }),
          'call_2': new ToolConfirmation({
            hint: 'confirm tool 2',
            confirmed: false,
          }),
        },
      }),
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event).toBeDefined();
    expect(event!.invocationId).toBe('inv_123');
    expect(event!.author).toBe('test_agent');
    expect(event!.content!.parts!.length).toBe(2);

    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_1',
    );
    expect(call1).toBeDefined();
    expect(call1!.functionCall!.name).toBe('adk_request_confirmation');
    expect(call1!.functionCall!.args!['toolConfirmation']).toEqual(
      new ToolConfirmation({
        hint: 'confirm tool 1',
        confirmed: false,
      }),
    );

    const call2 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_2',
    );
    expect(call2).toBeDefined();
    expect(call2!.functionCall!.name).toBe('adk_request_confirmation');
    expect(call2!.functionCall!.args!['toolConfirmation']).toEqual(
      new ToolConfirmation({
        hint: 'confirm tool 2',
        confirmed: false,
      }),
    );
  });

  it('should skip confirmation if original function call is not found', () => {
    const functionCallEvent = createEvent({
      content: {
        role: 'user',
        parts: [
          {
            functionCall: {
              name: 'tool_1',
              args: {arg: 'val1'},
              id: 'call_1',
            },
          },
        ],
      },
    });

    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          'call_1': new ToolConfirmation({
            hint: 'confirm tool 1',
            confirmed: false,
          }),
          'call_missing': new ToolConfirmation({
            hint: 'confirm tool missing',
            confirmed: false,
          }),
        },
      }),
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event).toBeDefined();
    expect(event!.content!.parts!.length).toBe(1);
    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_1',
    );
    expect(call1).toBeDefined();
  });

  it('should default the role to user for a content-less event', () => {
    const functionCallEvent = createEvent({
      content: {
        role: 'user',
        parts: [{functionCall: {name: 'tool_1', args: {}, id: 'call_1'}}],
      },
    });
    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          'call_1': new ToolConfirmation({hint: 'ok?', confirmed: false}),
        },
      }),
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event!.content!.role).toBe('user');
    expect(event!.content!.parts!.length).toBe(1);
    expect(event!.content!.parts![0].functionCall!.name).toBe(
      'adk_request_confirmation',
    );
  });
});

describe('generateClientFunctionCallId', () => {
  it('should generate a valid ID with prefix', () => {
    const id = generateClientFunctionCallId();
    expect(id).toMatch(/^adk-/);
  });
});

describe('mergeParallelFunctionResponseEvents', () => {
  it('should merge multiple events into one', () => {
    const event1 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool1', response: {result: 1}, id: 'id1'}},
        ],
      },
    });
    const event2 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool2', response: {result: 2}, id: 'id2'}},
        ],
      },
    });
    const merged = mergeParallelFunctionResponseEvents([event1, event2]);
    expect(merged.content!.parts!.length).toBe(2);
    expect(merged.content!.parts![0].functionResponse!.name).toBe('tool1');
    expect(merged.content!.parts![1].functionResponse!.name).toBe('tool2');
  });

  it('should throw if no events provided', () => {
    expect(() => mergeParallelFunctionResponseEvents([])).toThrow(
      'No function response events provided.',
    );
  });

  it('should return the same event if only one provided', () => {
    const event = createEvent();
    const merged = mergeParallelFunctionResponseEvents([event]);
    expect(merged).toBe(event);
  });

  it('should keep the nested stateDelta keys written by both events', () => {
    const event1 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool1', response: {result: 1}, id: 'id1'}},
        ],
      },
      actions: createEventActions({stateDelta: {user: {name: 'a'}}}),
    });
    const event2 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool2', response: {result: 2}, id: 'id2'}},
        ],
      },
      actions: createEventActions({stateDelta: {user: {age: 2}}}),
    });

    const merged = mergeParallelFunctionResponseEvents([event1, event2]);

    expect(merged.actions.stateDelta).toEqual({user: {name: 'a', age: 2}});
  });
});

describe('findEventByFunctionCallId', () => {
  it('should find event with matching functionCall id', () => {
    const event1 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: 'tool1', args: {}}}],
      },
    });
    const event2 = createEvent({
      invocationId: 'inv-2',
      author: 'agent-2',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-2', name: 'tool2', args: {}}}],
      },
    });
    expect(findEventByFunctionCallId([event1, event2], 'call-1')).toBe(event1);
    expect(findEventByFunctionCallId([event1, event2], 'call-2')).toBe(event2);
  });

  it('should return undefined if no matching functionCall id found or events empty', () => {
    const event1 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: 'tool1', args: {}}}],
      },
    });
    expect(findEventByFunctionCallId([event1], 'non-existent')).toBeUndefined();
    expect(findEventByFunctionCallId([], 'call-1')).toBeUndefined();
  });
});

describe('findMatchingFunctionCall', () => {
  it('should find matching function call for last event function response', () => {
    const callEvent = createEvent({
      invocationId: 'inv-1',
      author: 'sub-agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'lro-id-123', name: 'longRunningOp', args: {}}},
        ],
      },
    });
    const responseEvent = createEvent({
      invocationId: 'inv-2',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'lro-id-123',
              name: 'longRunningOp',
              response: {status: 'DONE'},
            },
          },
        ],
      },
    });
    expect(findMatchingFunctionCall([callEvent, responseEvent])).toBe(
      callEvent,
    );
  });

  it('should return undefined if last event is not function response or events empty', () => {
    const callEvent = createEvent({
      invocationId: 'inv-1',
      author: 'sub-agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'lro-id-123', name: 'longRunningOp', args: {}}},
        ],
      },
    });
    expect(findMatchingFunctionCall([callEvent])).toBeUndefined();
    expect(findMatchingFunctionCall([])).toBeUndefined();
  });
});
