/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  FunctionTool,
  getFunctionResponses,
  InMemoryRunner,
  LlmAgent,
  mergeParallelFunctionResponseEvents,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

describe('E2E Merge Parallel Function Response Events', () => {
  const envPath = path.resolve(__dirname, '../../.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  it('should always pass (dummy test for vitest)', () => {
    expect(true).toBe(true);
  });

  it('should cleanly merge parallel function response events in standalone e2e verification without mocks', () => {
    const event1 = createEvent({
      invocationId: 'inv-parallel-e2e',
      author: 'weather_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'get_temperature',
              id: 'call_temp_123',
              response: {temp: '72F'},
            },
          },
        ],
      },
    });

    const event2 = createEvent({
      invocationId: 'inv-parallel-e2e',
      author: 'weather_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'get_humidity',
              id: 'call_hum_456',
              response: {humidity: '45%'},
            },
          },
        ],
      },
    });

    const consolidated = mergeParallelFunctionResponseEvents([event1, event2]);
    const responses = getFunctionResponses(consolidated);

    expect(consolidated.invocationId).toBe('inv-parallel-e2e');
    expect(consolidated.author).toBe('weather_agent');
    expect(responses.length).toBe(2);
    expect(responses[0].name).toBe('get_temperature');
    expect(responses[1].name).toBe('get_humidity');
  });

  it.skipIf(!hasAKey)(
    'should execute multiple tools in parallel and merge response events in a live model run',
    async () => {
      const tempTool = new FunctionTool({
        name: 'get_temperature',
        description: 'Gets the current temperature in Fahrenheit for a city.',
        parameters: z.object({
          city: z.string().describe('The city name'),
        }),
        execute: async ({city}) => ({temperature: '75F', city}),
      });

      const humidityTool = new FunctionTool({
        name: 'get_humidity',
        description:
          'Gets the current relative humidity percentage for a city.',
        parameters: z.object({
          city: z.string().describe('The city name'),
        }),
        execute: async ({city}) => ({humidity: '50%', city}),
      });

      const agent = new LlmAgent({
        name: 'parallel_weather_agent',
        description: 'An agent that checks weather metrics.',
        instruction:
          'When asked about weather metrics, ALWAYS invoke get_temperature and get_humidity simultaneously.',
        model: 'gemini-2.5-flash',
        tools: [tempTool, humidityTool],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_parallel_tools_test',
      });

      const session = await runner.sessionService.createSession({
        appName: 'e2e_parallel_tools_test',
        userId: 'test_user',
      });

      let foundMergedEvent = false;
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent(
          'Please check BOTH the temperature and humidity in Seattle right now simultaneously.',
        ),
      })) {
        const responses = getFunctionResponses(event);
        if (responses.length >= 2) {
          foundMergedEvent = true;
          const names = responses.map((r) => r.name);
          expect(names).toContain('get_temperature');
          expect(names).toContain('get_humidity');
        }
      }

      expect(foundMergedEvent).toBe(true);
    },
    60000,
  );
});
