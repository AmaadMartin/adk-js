/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  createEvent,
  FunctionTool,
  handleFunctionCallsLive,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

class AuditLogPlugin extends BasePlugin {
  readonly auditLogs: Array<{event: string; tool: string; args: unknown}> = [];
  blockedLocations: Set<string> = new Set(['area51', 'secret base']);

  constructor() {
    super('auditLogPlugin');
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
  }: Parameters<BasePlugin['beforeToolCallback']>[0]): Promise<
    Record<string, unknown> | undefined
  > {
    this.auditLogs.push({
      event: 'before_tool',
      tool: tool.name,
      args: toolArgs,
    });

    if (tool.name === 'getWeather' && typeof toolArgs.location === 'string') {
      if (this.blockedLocations.has(toolArgs.location.toLowerCase())) {
        return {
          error: `Security violation: access to location '${toolArgs.location}' is restricted in live streaming.`,
        };
      }
    }
    return undefined;
  }

  override async afterToolCallback({
    tool,
    toolArgs,
    result,
  }: Parameters<BasePlugin['afterToolCallback']>[0]): Promise<
    Record<string, unknown> | undefined
  > {
    this.auditLogs.push({
      event: 'after_tool',
      tool: tool.name,
      args: toolArgs,
    });
    if (tool.name === 'getWeather' && !result.error) {
      return {
        ...result,
        audited: true,
      };
    }
    return undefined;
  }

  override async onToolErrorCallback({
    tool,
    error,
  }: Parameters<BasePlugin['onToolErrorCallback']>[0]): Promise<
    Record<string, unknown> | undefined
  > {
    this.auditLogs.push({
      event: 'tool_error',
      tool: tool.name,
      args: {errorMessage: error.message},
    });
    return {
      error: `Intercepted error in tool ${tool.name}: ${error.message}`,
    };
  }
}

describe('functions_live_integration_test', () => {
  let pluginManager: PluginManager;
  let auditPlugin: AuditLogPlugin;
  let invocationContext: InvocationContext;
  let toolsDict: Record<string, BaseTool>;

  const getWeatherTool = new FunctionTool({
    name: 'getWeather',
    description: 'Get weather for location',
    parameters: z.object({
      location: z.string(),
    }),
    execute: async ({location}) => {
      if (location === 'Atlantis') {
        throw new Error('Location coordinates lost in ocean');
      }
      return {temperature: 22, conditions: 'Sunny', location};
    },
  });

  const calculateTool = new FunctionTool({
    name: 'calculate',
    description: 'Perform arithmetic',
    parameters: z.object({
      a: z.number(),
      b: z.number(),
      op: z.enum(['add', 'subtract']),
    }),
    execute: async ({a, b, op}) => {
      if (op === 'add') return {result: a + b};
      return {result: a - b};
    },
  });

  beforeEach(() => {
    auditPlugin = new AuditLogPlugin();
    pluginManager = new PluginManager([auditPlugin]);
    const agent = new LlmAgent({name: 'live_agent', model: 'gemini-live'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_integration_live',
      session: {id: 'session_integration_live'} as Session,
      agent,
      pluginManager,
    });
    toolsDict = {
      getWeather: getWeatherTool,
      calculate: calculateTool,
    };
    vi.restoreAllMocks();
  });

  it('should integrate real tools and plugins for parallel tool calls in live mode', async () => {
    const liveEvent = createEvent({
      invocationId: invocationContext.invocationId,
      liveSessionId: 'websocket_session_8899',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_weather_tokyo',
              name: 'getWeather',
              args: {location: 'Tokyo'},
            },
          },
          {
            functionCall: {
              id: 'call_calc_sum',
              name: 'calculate',
              args: {a: 15, b: 25, op: 'add'},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent: liveEvent,
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(responseEvent).not.toBeNull();
    expect(responseEvent!.liveSessionId).toBe('websocket_session_8899');
    expect(responseEvent!.content!.role).toBe('user');
    expect(responseEvent!.content!.parts!.length).toBe(2);

    const weatherPart = responseEvent!.content!.parts!.find(
      (p) => p.functionResponse?.id === 'call_weather_tokyo',
    );
    expect(weatherPart?.functionResponse?.response).toEqual({
      temperature: 22,
      conditions: 'Sunny',
      location: 'Tokyo',
      audited: true,
    });

    const calcPart = responseEvent!.content!.parts!.find(
      (p) => p.functionResponse?.id === 'call_calc_sum',
    );
    expect(calcPart?.functionResponse?.response).toEqual({
      result: 40,
    });

    expect(auditPlugin.auditLogs.length).toBe(4); // 2 before, 2 after
  });

  it('should intercept security violations via plugin before callback without terminating live session', async () => {
    const liveEvent = createEvent({
      invocationId: invocationContext.invocationId,
      liveSessionId: 'websocket_session_secure',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_secret_weather',
              name: 'getWeather',
              args: {location: 'secret base'},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent: liveEvent,
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(responseEvent).not.toBeNull();
    expect(responseEvent!.liveSessionId).toBe('websocket_session_secure');
    expect(
      responseEvent!.content!.parts![0].functionResponse?.response,
    ).toEqual({
      error:
        "Security violation: access to location 'secret base' is restricted in live streaming.",
    });
  });

  it('should catch runtime tool errors cleanly and format them via plugin onToolErrorCallback in live mode', async () => {
    const liveEvent = createEvent({
      invocationId: invocationContext.invocationId,
      liveSessionId: 'websocket_session_err',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_lost_weather',
              name: 'getWeather',
              args: {location: 'Atlantis'},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent: liveEvent,
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(responseEvent).not.toBeNull();
    expect(responseEvent!.liveSessionId).toBe('websocket_session_err');
    expect(
      responseEvent!.content!.parts![0].functionResponse?.response,
    ).toEqual({
      error:
        "Intercepted error in tool getWeather: Error in tool 'getWeather': Location coordinates lost in ocean",
    });
  });
});
