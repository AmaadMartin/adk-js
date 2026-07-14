/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  Event,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  mergeParallelFunctionResponseEvents,
  PluginManager,
  Session,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

describe('E2E mergeParallelFunctionResponseEvents', () => {
  it('should merge parallel tool execution response events directly without mocks', async () => {
    const weatherTool = new FunctionTool({
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: z.object({city: z.string()}),
      execute: async ({city}) => ({temperature: 72, condition: 'Sunny', city}),
    });

    const timeTool = new FunctionTool({
      name: 'get_time',
      description: 'Get current time for a timezone',
      parameters: z.object({timezone: z.string()}),
      execute: async ({timezone}) => ({time: '12:00 PM', timezone}),
    });

    const pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'e2e_agent', model: 'test_model'});
    const session = {
      id: 'test-session-id',
      state: {},
    } as unknown as Session;

    const invocationContext = new InvocationContext({
      session,
      invocationId: 'e2e-inv-1',
      agent,
      pluginManager,
    });

    const weatherCall: FunctionCall = {
      name: 'get_weather',
      args: {city: 'Mountain View'},
      id: 'call-weather-1',
    };

    const timeCall: FunctionCall = {
      name: 'get_time',
      args: {timezone: 'PST'},
      id: 'call-time-1',
    };

    const toolsDict = {
      get_weather: weatherTool,
      get_time: timeTool,
    };

    // Execute multiple tool calls concurrently via handleFunctionCallList (no mocks)
    const mergedEvent = (await handleFunctionCallList({
      invocationContext,
      functionCalls: [weatherCall, timeCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    })) as Event;

    expect(mergedEvent).toBeDefined();
    expect(mergedEvent.invocationId).toBe('e2e-inv-1');
    expect(mergedEvent.author).toBe('e2e_agent');
    expect(mergedEvent.content?.parts).toHaveLength(2);
    expect(mergedEvent.content?.parts![0].functionResponse?.name).toBe(
      'get_weather',
    );
    expect(mergedEvent.content?.parts![0].functionResponse?.response).toEqual({
      temperature: 72,
      condition: 'Sunny',
      city: 'Mountain View',
    });
    expect(mergedEvent.content?.parts![1].functionResponse?.name).toBe(
      'get_time',
    );
    expect(mergedEvent.content?.parts![1].functionResponse?.response).toEqual({
      time: '12:00 PM',
      timezone: 'PST',
    });
  });

  it('should merge multiple standalone Event instances cleanly via public export', () => {
    const timestamp = Date.now();
    const event1 = createEvent({
      invocationId: 'public-inv-1',
      author: 'agent-alpha',
      branch: 'main',
      timestamp,
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'toolA', response: {ok: true}, id: 'idA'}},
        ],
      },
      actions: createEventActions({
        stateDelta: {keyA: 'valA'},
      }),
    });

    const event2 = createEvent({
      invocationId: 'public-inv-2',
      author: 'agent-beta',
      branch: 'sub',
      timestamp: timestamp + 100,
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'toolB', response: {ok: true}, id: 'idB'}},
        ],
      },
      actions: createEventActions({
        stateDelta: {keyB: 'valB'},
      }),
    });

    const merged = mergeParallelFunctionResponseEvents([event1, event2]);

    expect(merged.invocationId).toBe('public-inv-1');
    expect(merged.author).toBe('agent-alpha');
    expect(merged.branch).toBe('main');
    expect(merged.timestamp).toBe(timestamp);
    expect(merged.content?.parts).toHaveLength(2);
    expect(merged.content?.parts![0].functionResponse?.name).toBe('toolA');
    expect(merged.content?.parts![1].functionResponse?.name).toBe('toolB');
    expect(merged.actions.stateDelta).toEqual({keyA: 'valA', keyB: 'valB'});
  });
});
