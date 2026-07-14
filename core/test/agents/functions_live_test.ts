/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  createEvent,
  executeSingleFunctionCallLive,
  FunctionTool,
  handleFunctionCallsLive,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
  ToolConfirmation,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import * as tracing from '../../src/telemetry/tracing.js';

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

const nonErrorThrowTool = new FunctionTool({
  name: 'nonErrorThrowTool',
  description: 'non error throw tool',
  parameters: z.object({}),
  execute: async () => {
    throw 'string error message';
  },
});

class RawThrowingTool extends BaseTool {
  constructor() {
    super({name: 'rawThrowingTool', description: 'throws raw non-error'});
  }
  override async runAsync(): Promise<unknown> {
    throw 'raw string error';
  }
}
const rawThrowingTool = new RawThrowingTool();

const longRunningTool = new FunctionTool({
  name: 'longRunningTool',
  description: 'long running tool',
  parameters: z.object({}),
  isLongRunning: true,
  execute: async () => {
    return null;
  },
});

const arrayTool = new FunctionTool({
  name: 'arrayTool',
  description: 'returns array',
  parameters: z.object({}),
  execute: async () => {
    return ['item1', 'item2'];
  },
});

const primitiveTool = new FunctionTool({
  name: 'primitiveTool',
  description: 'returns primitive',
  parameters: z.object({}),
  execute: async () => {
    return 'primitive result';
  },
});

const nullNormalTool = new FunctionTool({
  name: 'nullNormalTool',
  description: 'returns null normally',
  parameters: z.object({}),
  execute: async () => {
    return null;
  },
});

class TestPlugin extends BasePlugin {
  constructor(name = 'testPlugin') {
    super(name);
  }
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

describe('executeSingleFunctionCallLive and handleFunctionCallsLive', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;
  let toolsDict: Record<string, BaseTool>;

  beforeEach(() => {
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_live_123',
      session: {id: 'session_live_123'} as Session,
      agent,
      pluginManager,
    });
    toolsDict = {
      testTool,
      errorTool,
      nonErrorThrowTool,
      rawThrowingTool,
      longRunningTool,
      arrayTool,
      primitiveTool,
      nullNormalTool,
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeSingleFunctionCallLive', () => {
    it('should execute normal tool and return response event', async () => {
      const functionCall: FunctionCall = {
        id: 'call_1',
        name: 'testTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        result: 'tool executed',
      });
    });

    it('should catch error when tool is not found in toolsDict and format error response without throwing', async () => {
      const functionCall: FunctionCall = {
        id: 'call_missing',
        name: 'missingTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        error: 'Function missingTool is not found in the toolsDict.',
      });
    });

    it('should catch error when tool is not found and use plugin onToolErrorCallback response if provided', async () => {
      const plugin = new TestPlugin('errorHandlerPlugin');
      plugin.onToolErrorCallbackResponse = {
        customError: 'handled missing tool',
      };
      pluginManager.registerPlugin(plugin);

      const functionCall: FunctionCall = {
        id: 'call_missing_2',
        name: 'missingTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        customError: 'handled missing tool',
      });
    });

    it('should short-circuit tool execution when plugin beforeToolCallback returns response', async () => {
      const plugin = new TestPlugin('beforePlugin');
      plugin.beforeToolCallbackResponse = {result: 'short circuited by plugin'};
      pluginManager.registerPlugin(plugin);

      const functionCall: FunctionCall = {
        id: 'call_2',
        name: 'testTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        result: 'short circuited by plugin',
      });
    });

    it('should short-circuit tool execution when canonical beforeToolCallback returns response', async () => {
      const beforeCallback: SingleBeforeToolCallback = async () => ({
        result: 'short circuited by canonical before callback',
      });

      const functionCall: FunctionCall = {
        id: 'call_3',
        name: 'testTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [beforeCallback],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        result: 'short circuited by canonical before callback',
      });
    });

    it('should catch tool execution Error and return { error: message } without throwing', async () => {
      const functionCall: FunctionCall = {
        id: 'call_err',
        name: 'errorTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        error: "Error in tool 'errorTool': tool error message content",
      });
    });

    it('should catch tool execution Error and use plugin onToolErrorCallback response if provided', async () => {
      const plugin = new TestPlugin('errPlugin');
      plugin.onToolErrorCallbackResponse = {error: 'plugin override error'};
      pluginManager.registerPlugin(plugin);

      const functionCall: FunctionCall = {
        id: 'call_err_2',
        name: 'errorTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        error: 'plugin override error',
      });
    });

    it('should catch non-Error thrown during tool execution and return { error: object } without throwing', async () => {
      const functionCall: FunctionCall = {
        id: 'call_non_err',
        name: 'nonErrorThrowTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        error: "Error in tool 'nonErrorThrowTool': string error message",
      });
    });

    it('should catch non-Error thrown during tool execution and use plugin onToolErrorCallback response if provided', async () => {
      const plugin = new TestPlugin('errPlugin2');
      plugin.onToolErrorCallbackResponse = {
        error: 'plugin handled string throw',
      };
      pluginManager.registerPlugin(plugin);

      const functionCall: FunctionCall = {
        id: 'call_non_err_2',
        name: 'nonErrorThrowTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        error: 'plugin handled string throw',
      });
    });

    it('should catch raw non-Error thrown directly by BaseTool.runAsync and format error without throwing', async () => {
      const functionCall: FunctionCall = {
        id: 'call_raw_non_err',
        name: 'rawThrowingTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        error: 'raw string error',
      });
    });

    it('should catch raw non-Error thrown directly by BaseTool.runAsync and use onToolErrorCallback response if provided', async () => {
      const plugin = new TestPlugin('errPluginRaw');
      plugin.onToolErrorCallbackResponse = {error: 'plugin handled raw throw'};
      pluginManager.registerPlugin(plugin);

      const functionCall: FunctionCall = {
        id: 'call_raw_non_err_2',
        name: 'rawThrowingTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        error: 'plugin handled raw throw',
      });
    });

    it('should alter response when plugin afterToolCallback returns response', async () => {
      const plugin = new TestPlugin('afterPlugin');
      plugin.afterToolCallbackResponse = {
        result: 'altered by plugin after callback',
      };
      pluginManager.registerPlugin(plugin);

      const functionCall: FunctionCall = {
        id: 'call_after_1',
        name: 'testTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        result: 'altered by plugin after callback',
      });
    });

    it('should alter response when canonical afterToolCallback returns response', async () => {
      const afterCallback: SingleAfterToolCallback = async () => ({
        result: 'altered by canonical after callback',
      });

      const functionCall: FunctionCall = {
        id: 'call_after_2',
        name: 'testTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [afterCallback],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        result: 'altered by canonical after callback',
      });
    });

    it('should return null when tool isLongRunning and returns null or undefined', async () => {
      const functionCall: FunctionCall = {
        id: 'call_lr',
        name: 'longRunningTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).toBeNull();
    });

    it('should return { results: array } when tool returns array', async () => {
      const functionCall: FunctionCall = {
        id: 'call_arr',
        name: 'arrayTool',
        args: {},
      };
      const event = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(event).not.toBeNull();
      expect(event!.content!.parts![0].functionResponse!.response).toEqual({
        results: ['item1', 'item2'],
      });
    });

    it('should return { result: primitive } when tool returns primitive or null when not long running', async () => {
      const callPrimitive: FunctionCall = {
        id: 'call_prim',
        name: 'primitiveTool',
        args: {},
      };
      const eventPrim = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall: callPrimitive,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(eventPrim!.content!.parts![0].functionResponse!.response).toEqual({
        result: 'primitive result',
      });

      const callNull: FunctionCall = {
        id: 'call_null',
        name: 'nullNormalTool',
        args: {},
      };
      const eventNull = await executeSingleFunctionCallLive({
        invocationContext,
        functionCall: callNull,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(eventNull!.content!.parts![0].functionResponse!.response).toEqual({
        result: null,
      });
    });

    it('should pass toolConfirmation down to Context when provided', async () => {
      const confirmation: ToolConfirmation = {
        toolName: 'testTool',
        functionCallId: 'call_confirm',
        confirmed: true,
      };
      const functionCall: FunctionCall = {
        id: 'call_confirm',
        name: 'testTool',
        args: {},
      };
      let capturedConfirmation: ToolConfirmation | undefined;
      const spyBefore: SingleBeforeToolCallback = async ({context}) => {
        capturedConfirmation = context.toolConfirmation;
        return undefined;
      };
      await executeSingleFunctionCallLive({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks: [spyBefore],
        afterToolCallbacks: [],
        toolConfirmation: confirmation,
      });
      expect(capturedConfirmation).toEqual(confirmation);
    });
  });

  describe('handleFunctionCallsLive', () => {
    it('should return null when functionCallEvent has no function calls', async () => {
      const event = createEvent({
        invocationId: invocationContext.invocationId,
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
      const result = await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: event,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(result).toBeNull();
    });

    it('should return null when all function calls are filtered out', async () => {
      const event = createEvent({
        invocationId: invocationContext.invocationId,
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'id1', name: 'testTool', args: {}}},
            {functionCall: {id: 'id2', name: 'testTool', args: {}}},
          ],
        },
      });
      const result = await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: event,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
        filters: new Set(['id_allowed']),
      });
      expect(result).toBeNull();
    });

    it('should only execute function calls matching filters', async () => {
      const event = createEvent({
        invocationId: invocationContext.invocationId,
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'allowed_id', name: 'testTool', args: {}}},
            {functionCall: {id: 'blocked_id', name: 'errorTool', args: {}}},
          ],
        },
      });
      const result = await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: event,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
        filters: new Set(['allowed_id']),
      });
      expect(result).not.toBeNull();
      expect(result!.content!.parts!.length).toBe(1);
      expect(result!.content!.parts![0].functionResponse!.id).toBe(
        'allowed_id',
      );
      expect(result!.content!.parts![0].functionResponse!.response).toEqual({
        result: 'tool executed',
      });
    });

    it('should return null when all executed function calls return null (e.g. long running)', async () => {
      const event = createEvent({
        invocationId: invocationContext.invocationId,
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'lr_1', name: 'longRunningTool', args: {}}},
            {functionCall: {id: 'lr_2', name: 'longRunningTool', args: {}}},
          ],
        },
      });
      const result = await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: event,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(result).toBeNull();
    });

    it('should execute single tool call, return merged event, and preserve liveSessionId', async () => {
      const event = createEvent({
        invocationId: invocationContext.invocationId,
        liveSessionId: 'live_session_xyz',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call_1', name: 'testTool', args: {}}}],
        },
      });
      const result = await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: event,
        toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });
      expect(result).not.toBeNull();
      expect(result!.liveSessionId).toBe('live_session_xyz');
      expect(result!.content!.parts!.length).toBe(1);
      expect(result!.content!.parts![0].functionResponse!.response).toEqual({
        result: 'tool executed',
      });
    });

    it('should execute parallel tool calls concurrently, merge responses, preserve liveSessionId, and trace merged tools', async () => {
      const traceMergedSpy = vi.spyOn(tracing, 'traceMergedToolCalls');
      const startSpanSpy = vi.spyOn(tracing.tracer, 'startActiveSpan');

      let firstStarted = false;
      let secondStarted = false;
      const slowTool1 = new FunctionTool({
        name: 'slowTool1',
        description: 'slow tool 1',
        parameters: z.object({}),
        execute: async () => {
          firstStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {result: 'slow 1 done'};
        },
      });
      const slowTool2 = new FunctionTool({
        name: 'slowTool2',
        description: 'slow tool 2',
        parameters: z.object({}),
        execute: async () => {
          secondStarted = true;
          // Verify that when slowTool2 starts, slowTool1 has also started concurrently
          expect(firstStarted).toBe(true);
          return {result: 'slow 2 done'};
        },
      });

      const customToolsDict: Record<string, BaseTool> = {
        slowTool1,
        slowTool2,
      };

      const event = createEvent({
        invocationId: invocationContext.invocationId,
        liveSessionId: 'live_session_parallel',
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'slow_1', name: 'slowTool1', args: {}}},
            {functionCall: {id: 'slow_2', name: 'slowTool2', args: {}}},
          ],
        },
      });

      const result = await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: event,
        toolsDict: customToolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });

      expect(result).not.toBeNull();
      expect(result!.liveSessionId).toBe('live_session_parallel');
      expect(result!.content!.parts!.length).toBe(2);
      expect(firstStarted && secondStarted).toBe(true);

      expect(traceMergedSpy).toHaveBeenCalledTimes(1);
      expect(traceMergedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          responseEventId: result!.id,
          functionResponseEvent: result!,
        }),
      );
      expect(startSpanSpy).toHaveBeenCalledWith(
        'execute_tool (merged)',
        expect.any(Function),
      );
    });

    it('should correctly pass toolConfirmationDict down to context for matching calls in live mode', async () => {
      const confirmationMap: Record<string, ToolConfirmation> = {
        'conf_id_1': {
          toolName: 'testTool',
          functionCallId: 'conf_id_1',
          confirmed: true,
        },
      };
      const event = createEvent({
        invocationId: invocationContext.invocationId,
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'conf_id_1', name: 'testTool', args: {}}},
          ],
        },
      });

      let receivedConfirm: ToolConfirmation | undefined;
      const beforeCb: SingleBeforeToolCallback = async ({context}) => {
        receivedConfirm = context.toolConfirmation;
        return undefined;
      };

      await handleFunctionCallsLive({
        invocationContext,
        functionCallEvent: event,
        toolsDict,
        beforeToolCallbacks: [beforeCb],
        afterToolCallbacks: [],
        toolConfirmationDict: confirmationMap,
      });

      expect(receivedConfirm).toEqual(confirmationMap['conf_id_1']);
    });
  });
});
