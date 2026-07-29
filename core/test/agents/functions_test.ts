/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  BasePlugin,
  BaseTool,
  createEvent,
  createEventActions,
  Event,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunAsyncToolRequest,
  Session,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
  ToolConfirmation,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  findEventByFunctionCallId,
  findMatchingFunctionCall,
  generateClientFunctionCallId,
  getLongRunningFunctionCalls,
  mergeParallelFunctionResponseEvents,
} from '../../src/agents/functions.js';

// Get the test target function
const {
  handleFunctionCallList,
  generateAuthEvent,
  generateRequestConfirmationEvent,
} = functionsExportedForTestingOnly;

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

function randomIdForTestingOnly(): string {
  return (Math.random() * 100).toString();
}

describe('handleFunctionCallList', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;
  let functionCall: FunctionCall;
  let toolsDict: Record<string, BaseTool>;

  beforeEach(() => {
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
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

/** Creates an externally-resolvable promise for deterministic concurrency tests. */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return {promise, resolve};
}

/**
 * A tool that throws a non-`Error` value, exercising the branch that stores the
 * raw thrown value as the function response error. `FunctionTool` always wraps
 * thrown values in an `Error`, so a custom tool is required to reach it.
 */
class NonErrorThrowingTool extends BaseTool {
  constructor() {
    super({name: 'nonErrorTool', description: 'throws a non-Error value'});
  }

  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    const nonError = {reason: 'non-error failure'};
    throw nonError;
  }
}

describe('handleFunctionCallList - parallel execution', () => {
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

  it('should execute multiple tool calls concurrently', async () => {
    const releaseGate = deferred<void>();
    const startedA = deferred<void>();
    const startedB = deferred<void>();

    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'tool a',
      parameters: z.object({}),
      execute: async () => {
        startedA.resolve();
        await releaseGate.promise;
        return {result: 'a'};
      },
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'tool b',
      parameters: z.object({}),
      execute: async () => {
        startedB.resolve();
        await releaseGate.promise;
        return {result: 'b'};
      },
    });

    const resultPromise = handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'a', name: 'toolA', args: {}},
        {id: 'b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // Both tools must reach execution before either is allowed to finish. Under
    // sequential execution the second tool could not start until the first
    // returned, so awaiting both "started" gates would deadlock (and time out).
    await Promise.all([startedA.promise, startedB.promise]);
    releaseGate.resolve();

    const event = await resultPromise;
    expect(event).not.toBeNull();
    expect(event!.content!.parts!.length).toBe(2);
  });

  it('should preserve input order regardless of completion order', async () => {
    const slowGate = deferred<void>();
    const fastStarted = deferred<void>();

    const slowTool = new FunctionTool({
      name: 'slow',
      description: 'slow tool',
      parameters: z.object({}),
      execute: async () => {
        await slowGate.promise;
        return {result: 'slow'};
      },
    });
    const fastTool = new FunctionTool({
      name: 'fast',
      description: 'fast tool',
      parameters: z.object({}),
      execute: async () => {
        fastStarted.resolve();
        return {result: 'fast'};
      },
    });

    const resultPromise = handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'slow-id', name: 'slow', args: {}},
        {id: 'fast-id', name: 'fast', args: {}},
      ],
      toolsDict: {slow: slowTool, fast: fastTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // Let the fast tool (call index 1) run before releasing the slow tool
    // (call index 0), so completion order is the reverse of input order.
    await fastStarted.promise;
    slowGate.resolve();

    const event = await resultPromise;
    const parts = event!.content!.parts!;
    expect(parts[0].functionResponse!.name).toBe('slow');
    expect(parts[0].functionResponse!.id).toBe('slow-id');
    expect(parts[1].functionResponse!.name).toBe('fast');
    expect(parts[1].functionResponse!.id).toBe('fast-id');
  });

  it('should merge stateDelta and transferToAgent actions across concurrent calls', async () => {
    const stateToolA = new FunctionTool({
      name: 'stateA',
      description: 'writes state key a',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        toolContext!.actions.stateDelta['keyA'] = 'valueA';
        return {result: 'a'};
      },
    });
    const stateToolB = new FunctionTool({
      name: 'stateB',
      description: 'writes state key b',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        toolContext!.actions.stateDelta['keyB'] = 'valueB';
        return {result: 'b'};
      },
    });
    const transferTool = new FunctionTool({
      name: 'transfer',
      description: 'requests agent transfer',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        toolContext!.actions.transferToAgent = 'other_agent';
        return {result: 't'};
      },
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: '1', name: 'stateA', args: {}},
        {id: '2', name: 'stateB', args: {}},
        {id: '3', name: 'transfer', args: {}},
      ],
      toolsDict: {
        stateA: stateToolA,
        stateB: stateToolB,
        transfer: transferTool,
      },
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts!.length).toBe(3);
    expect(event!.actions!.stateDelta).toMatchObject({
      keyA: 'valueA',
      keyB: 'valueB',
    });
    expect(event!.actions!.transferToAgent).toBe('other_agent');
  });

  it('should reject (fail-fast) when one call targets a missing tool while a sibling is mid-flight', async () => {
    const slowStarted = deferred<void>();
    const slowGate = deferred<void>();

    const slowTool = new FunctionTool({
      name: 'slow',
      description: 'slow tool',
      parameters: z.object({}),
      execute: async () => {
        slowStarted.resolve();
        await slowGate.promise;
        return {result: 'slow'};
      },
    });

    const resultPromise = handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'missing-id', name: 'missingTool', args: {}},
        {id: 'slow-id', name: 'slow', args: {}},
      ],
      toolsDict: {slow: slowTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // Attach the rejection handler up front so no unhandled rejection is emitted
    // while we wait for the sibling to start.
    const rejection = expect(resultPromise).rejects.toThrow(
      'Function missingTool is not found in the toolsDict.',
    );

    // The sibling was dispatched concurrently and keeps running even though the
    // aggregate promise rejects. Unlike adk-python, JavaScript cannot cancel it,
    // so we assert it started rather than that it was cancelled.
    await slowStarted.promise;
    slowGate.resolve();

    await rejection;
  });

  it('should turn a tool-execution error into an error response without rejecting sibling successes', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: '1', name: 'errorTool', args: {}},
        {id: '2', name: 'testTool', args: {}},
      ],
      toolsDict: {errorTool, testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const parts = event!.content!.parts!;
    expect(parts.length).toBe(2);
    expect(parts[0].functionResponse!.response).toEqual({
      error: "Error in tool 'errorTool': tool error message content",
    });
    expect(parts[1].functionResponse!.response).toEqual({
      result: 'tool executed',
    });
  });

  it('should store a raw non-Error thrown value as the function response error', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: '1', name: 'nonErrorTool', args: {}}],
      toolsDict: {nonErrorTool: new NonErrorThrowingTool()},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      error: {reason: 'non-error failure'},
    });
  });

  it('should skip a long-running tool that returns no response', async () => {
    const longRunningTool = new FunctionTool({
      name: 'longRunning',
      description: 'long running tool with no response',
      parameters: z.object({}),
      isLongRunning: true,
      execute: async () => undefined,
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'lro', name: 'longRunning', args: {}},
        {id: 'normal', name: 'testTool', args: {}},
      ],
      toolsDict: {longRunning: longRunningTool, testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const parts = event!.content!.parts!;
    expect(parts.length).toBe(1);
    expect(parts[0].functionResponse!.name).toBe('testTool');
  });

  it('should only execute calls whose id is included in filters', async () => {
    const executed: string[] = [];
    const makeTool = (name: string) =>
      new FunctionTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => {
          executed.push(name);
          return {result: name};
        },
      });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'keep', name: 'toolKeep', args: {}},
        {id: 'drop', name: 'toolDrop', args: {}},
        {name: 'toolNoId', args: {}},
      ],
      toolsDict: {
        toolKeep: makeTool('toolKeep'),
        toolDrop: makeTool('toolDrop'),
        toolNoId: makeTool('toolNoId'),
      },
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
      filters: new Set(['keep']),
    });

    expect(executed).toEqual(['toolKeep']);
    expect(event!.content!.parts!.length).toBe(1);
    expect(event!.content!.parts![0].functionResponse!.name).toBe('toolKeep');
  });

  it('should propagate toolConfirmation from toolConfirmationDict to the tool context', async () => {
    const confirmation = new ToolConfirmation({
      hint: 'confirm',
      confirmed: true,
    });
    let seenConfirmation: ToolConfirmation | undefined;
    const confirmTool = new FunctionTool({
      name: 'confirmTool',
      description: 'reads its tool confirmation',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        seenConfirmation = toolContext!.toolConfirmation;
        return {result: 'ok'};
      },
    });

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'call-x', name: 'confirmTool', args: {}}],
      toolsDict: {confirmTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
      toolConfirmationDict: {'call-x': confirmation},
    });

    expect(seenConfirmation).toBe(confirmation);
  });

  it('should wrap a primitive tool result into a {result} object', async () => {
    const primitiveTool = new FunctionTool({
      name: 'primitive',
      description: 'returns a primitive',
      parameters: z.object({}),
      execute: async () => 'hello',
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: '1', name: 'primitive', args: {}}],
      toolsDict: {primitive: primitiveTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      result: 'hello',
    });
  });

  it('should wrap a null tool result into a {result: null} object', async () => {
    const nullTool = new FunctionTool({
      name: 'nullTool',
      description: 'returns null',
      parameters: z.object({}),
      execute: async () => null,
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: '1', name: 'nullTool', args: {}}],
      toolsDict: {nullTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      result: null,
    });
  });

  it('should return null for empty functionCalls', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [],
      toolsDict: {},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).toBeNull();
  });

  it('should return null when filters exclude every call', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'a', name: 'testTool', args: {}}],
      toolsDict: {testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
      filters: new Set(['nonexistent']),
    });
    expect(event).toBeNull();
  });
});

describe('generateAuthEvent', () => {
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

  it('should return undefined if no requestedAuthConfigs', () => {
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeUndefined();
  });

  it('should return undefined if requestedAuthConfigs is empty', () => {
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeUndefined();
  });

  it('should return auth event if requestedAuthConfigs is present', () => {
    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedAuthConfigs: {
          // @ts-expect-error - testing string assignments
          'call_1': 'auth_config_1',
          // @ts-expect-error - testing string assignments
          'call_2': 'auth_config_2',
        },
      }),
      content: {role: 'model', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeDefined();
    expect(event!.invocationId).toBe('inv_123');
    expect(event!.author).toBe('test_agent');
    expect(event!.content!.parts!.length).toBe(2);

    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) => p.functionCall?.args?.['function_call_id'] === 'call_1',
    );
    expect(call1).toBeDefined();
    expect(call1!.functionCall!.name).toBe('adk_request_credential');
    expect(call1!.functionCall!.args!['auth_config']).toBe('auth_config_1');

    const call2 = parts.find(
      (p) => p.functionCall?.args?.['function_call_id'] === 'call_2',
    );
    expect(call2).toBeDefined();
    expect(call2!.functionCall!.name).toBe('adk_request_credential');
    expect(call2!.functionCall!.args!['auth_config']).toBe('auth_config_2');
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
});

describe('generateClientFunctionCallId', () => {
  it('should generate a valid ID with prefix', () => {
    const id = generateClientFunctionCallId();
    expect(id).toMatch(/^adk-/);
  });
});

describe('getLongRunningFunctionCalls', () => {
  it('should return IDs of long running function calls', () => {
    const functionCalls = [
      {name: 'longTool', id: 'call-1'},
      {name: 'shortTool', id: 'call-2'},
    ];
    const toolsDict: Record<string, BaseTool> = {
      'longTool': new FunctionTool({
        name: 'longTool',
        description: 'long',
        execute: async () => ({}),
        isLongRunning: true,
      }),
      'shortTool': new FunctionTool({
        name: 'shortTool',
        description: 'short',
        execute: async () => ({}),
        isLongRunning: false,
      }),
    };
    // @ts-expect-error ts will argue about toolsDict because getLongRunningFunctionCalls is improted from the source and BaseTool is imported from '@google/adk'.
    const result = getLongRunningFunctionCalls(functionCalls, toolsDict);
    expect(result.has('call-1')).toBe(true);
    expect(result.has('call-2')).toBe(false);
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
