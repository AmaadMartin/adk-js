/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  createEvent,
  Event,
  FunctionTool,
  handleFunctionCallsLive,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

describe('Live Function Calling E2E Format Verification', () => {
  it('should execute tools from simulated server message and return exact GenAI WebSocket function response format without mocks', async () => {
    const getWeatherTool = new FunctionTool({
      name: 'getWeather',
      description:
        'Get current weather conditions and temperature for a given location',
      parameters: z.object({
        location: z.string(),
      }),
      execute: async ({location}) => {
        return {
          location,
          temperature: 25,
          conditions: 'Sunny',
          humidity: 50,
        };
      },
    });

    const calculatorTool = new FunctionTool({
      name: 'calculator',
      description: 'Perform arithmetic computations',
      parameters: z.object({
        a: z.number(),
        b: z.number(),
        operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
      }),
      execute: async ({a, b, operation}) => {
        switch (operation) {
          case 'add':
            return {result: a + b};
          case 'subtract':
            return {result: a - b};
          case 'multiply':
            return {result: a * b};
          case 'divide':
            if (b === 0) throw new Error('Division by zero');
            return {result: a / b};
        }
      },
    });

    const toolsDict: Record<string, BaseTool> = {
      getWeather: getWeatherTool,
      calculator: calculatorTool,
    };

    const pluginManager = new PluginManager();
    const agent = new LlmAgent({
      name: 'weather_calc_live_agent',
      model: 'gemini-live-2.5-flash-native-audio',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'e2e_live_invocation_id',
      session: {id: 'e2e_live_session_id'} as Session,
      agent,
      pluginManager,
    });

    // Simulate incoming model message with parallel function calls from server WebSocket stream
    const serverMessageEvent: Event = createEvent({
      invocationId: invocationContext.invocationId,
      liveSessionId: 'websocket_live_session_uuid_9988',
      author: 'model',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'server_fc_id_weather_1',
              name: 'getWeather',
              args: {location: 'San Francisco'},
            },
          },
          {
            functionCall: {
              id: 'server_fc_id_calc_1',
              name: 'calculator',
              args: {a: 144, b: 12, operation: 'divide'},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent: serverMessageEvent,
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // Verify response event exists and conforms exactly to @google/genai WebSocket client response payload requirements
    expect(responseEvent).not.toBeNull();
    expect(responseEvent!.liveSessionId).toBe(
      'websocket_live_session_uuid_9988',
    );
    expect(responseEvent!.content).toBeDefined();
    expect(responseEvent!.content!.role).toBe('user');
    expect(responseEvent!.content!.parts).toBeDefined();
    expect(responseEvent!.content!.parts!.length).toBe(2);

    // Verify first part conforms to Part structure with functionResponse
    const part0 = responseEvent!.content!.parts![0];
    expect(part0.functionResponse).toBeDefined();
    expect(part0.functionResponse!.id).toBe('server_fc_id_weather_1');
    expect(part0.functionResponse!.name).toBe('getWeather');
    expect(part0.functionResponse!.response).toEqual({
      location: 'San Francisco',
      temperature: 25,
      conditions: 'Sunny',
      humidity: 50,
    });

    // Verify second part conforms to Part structure with functionResponse
    const part1 = responseEvent!.content!.parts![1];
    expect(part1.functionResponse).toBeDefined();
    expect(part1.functionResponse!.id).toBe('server_fc_id_calc_1');
    expect(part1.functionResponse!.name).toBe('calculator');
    expect(part1.functionResponse!.response).toEqual({
      result: 12,
    });

    // Ensure no unwanted client IDs polluted the response event
    expect(part0.functionCall).toBeUndefined();
    expect(part1.functionCall).toBeUndefined();
  });
});
