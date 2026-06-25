/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  maybeSetOtelProviders,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('Integration Telemetry Tool Call Tracing', () => {
  const exporter = new InMemorySpanExporter();
  const spanProcessor = new SimpleSpanProcessor(exporter);

  beforeAll(() => {
    // Register the OTel provider once for all tests in this suite
    maybeSetOtelProviders([{spanProcessors: [spanProcessor]}]);
  });

  beforeEach(() => {
    // Clear any spans collected from previous tests
    exporter.reset();
  });

  it('should generate spans with correct attributes for a single tool call', async () => {
    const testTool = new FunctionTool({
      name: 'getWeather',
      description: 'Get weather for a city',
      parameters: z.object({
        city: z.string(),
      }),
      execute: async ({city}) => {
        return {weather: `Sunny in ${city}`};
      },
    });

    const mockResponses = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'getWeather',
                    args: {city: 'Seattle'},
                    id: 'call-getweather-1',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{text: 'The weather in Seattle is Sunny.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const model = new GeminiWithMockResponses(mockResponses);

    const agent = new LlmAgent({
      name: 'weather_agent',
      description: 'A weather agent.',
      instruction: 'Call the getWeather tool when user asks for weather.',
      model: model,
      tools: [testTool],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'integration_tracing_test',
    });

    const session = await runner.sessionService.createSession({
      appName: 'integration_tracing_test',
      userId: 'test_user',
    });

    // Run the agent flow
    for await (const _event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [{text: 'What is the weather in Seattle?'}],
      },
    })) {
      // Consume the generator
    }

    const spans = exporter.getFinishedSpans();

    // Find the tool execution spans
    const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool'));
    expect(toolSpans.length).toBe(1);

    const singleToolSpan = toolSpans[0];
    expect(singleToolSpan.name).toBe('execute_tool getWeather');
    expect(singleToolSpan.attributes['gen_ai.operation.name']).toBe(
      'execute_tool',
    );
    expect(singleToolSpan.attributes['gen_ai.tool.name']).toBe('getWeather');
    expect(singleToolSpan.attributes['gen_ai.tool.type']).toBe('FunctionTool');
    expect(
      singleToolSpan.attributes['gcp.vertex.agent.tool_call_args'],
    ).toContain('Seattle');
    expect(
      singleToolSpan.attributes['gcp.vertex.agent.tool_response'],
    ).toContain('Sunny');
  });

  it('should generate spans and a merged span for parallel tool calls', async () => {
    const tool1 = new FunctionTool({
      name: 'getWeather',
      description: 'Get weather for a city',
      parameters: z.object({city: z.string()}),
      execute: async ({city}) => ({weather: `Sunny in ${city}`}),
    });

    const tool2 = new FunctionTool({
      name: 'getTraffic',
      description: 'Get traffic for a city',
      parameters: z.object({city: z.string()}),
      execute: async ({city}) => ({traffic: `Clear in ${city}`}),
    });

    const mockResponses = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'getWeather',
                    args: {city: 'Seattle'},
                    id: 'call-1',
                  },
                },
                {
                  functionCall: {
                    name: 'getTraffic',
                    args: {city: 'Seattle'},
                    id: 'call-2',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{text: 'It is sunny and clear in Seattle.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const model = new GeminiWithMockResponses(mockResponses);

    const agent = new LlmAgent({
      name: 'multi_agent',
      description: 'A multi tool agent.',
      instruction: 'Call getWeather and getTraffic together.',
      model: model,
      tools: [tool1, tool2],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'integration_tracing_parallel_test',
    });

    const session = await runner.sessionService.createSession({
      appName: 'integration_tracing_parallel_test',
      userId: 'test_user',
    });

    // Run the agent flow
    for await (const _event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [{text: 'How is weather and traffic in Seattle?'}],
      },
    })) {
      // Consume the generator
    }

    const spans = exporter.getFinishedSpans();

    // Find the tool execution spans
    const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool'));
    // We expect: "execute_tool getWeather", "execute_tool getTraffic", and "execute_tool (merged)"
    expect(toolSpans.length).toBe(3);

    const weatherSpan = toolSpans.find(
      (s) => s.name === 'execute_tool getWeather',
    );
    const trafficSpan = toolSpans.find(
      (s) => s.name === 'execute_tool getTraffic',
    );
    const mergedSpan = toolSpans.find(
      (s) => s.name === 'execute_tool (merged)',
    );

    expect(weatherSpan).toBeDefined();
    expect(
      weatherSpan!.attributes['gcp.vertex.agent.tool_call_args'],
    ).toContain('Seattle');
    expect(weatherSpan!.attributes['gcp.vertex.agent.tool_response']).toContain(
      'Sunny',
    );

    expect(trafficSpan).toBeDefined();
    expect(
      trafficSpan!.attributes['gcp.vertex.agent.tool_call_args'],
    ).toContain('Seattle');
    expect(trafficSpan!.attributes['gcp.vertex.agent.tool_response']).toContain(
      'Clear',
    );

    expect(mergedSpan).toBeDefined();
    expect(mergedSpan!.attributes['gen_ai.operation.name']).toBe(
      'execute_tool',
    );
    expect(mergedSpan!.attributes['gen_ai.tool.name']).toBe('(merged tools)');
    expect(mergedSpan!.attributes['gcp.vertex.agent.tool_response']).toContain(
      'getWeather',
    );
    expect(mergedSpan!.attributes['gcp.vertex.agent.tool_response']).toContain(
      'getTraffic',
    );
  });
});
