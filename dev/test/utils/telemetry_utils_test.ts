/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {Part} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {ApiServerSpanExporter} from '../../src/utils/telemetry_utils.js';

/** Calls `getWeather` once, then answers with text. */
class WeatherCallingLlm extends BaseLlm {
  private calls = 0;

  constructor() {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const part: Part =
      this.calls++ === 0
        ? {functionCall: {id: 'fc_1', name: 'getWeather', args: {city: 'Oslo'}}}
        : {text: 'It is sunny in Oslo.'};
    yield {content: {role: 'model', parts: [part]}} as LlmResponse;
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('WeatherCallingLlm does not support live mode.');
  }
}

const traceDict: Record<string, Record<string, unknown>> = {};
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [
    new SimpleSpanProcessor(new ApiServerSpanExporter(traceDict)),
  ],
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

describe('ApiServerSpanExporter', () => {
  it('stores a tool span under the id of the response event the runner emits', async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'trace_app',
      userId: 'u1',
    });
    const runner = new Runner({
      appName: 'trace_app',
      agent: new LlmAgent({
        name: 'weather_agent',
        model: new WeatherCallingLlm(),
        tools: [
          new FunctionTool({
            name: 'getWeather',
            description: 'reports the weather',
            parameters: z.object({city: z.string()}),
            execute: async ({city}) => ({forecast: `sunny in ${city}`}),
          }),
        ],
      }),
      sessionService,
    });

    const responseEventIds: string[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'weather in Oslo?'}]},
    })) {
      if (event.content?.parts?.[0]?.functionResponse) {
        responseEventIds.push(event.id);
      }
    }
    await provider.forceFlush();

    expect(responseEventIds).toHaveLength(1);
    // `/debug/trace/:eventId` reads exactly this map, so a missing key is the
    // 404 the dev UI shows for a tool call.
    expect(traceDict[responseEventIds[0]]).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'getWeather',
      'gen_ai.tool.call.id': 'fc_1',
      'gcp.vertex.agent.event_id': responseEventIds[0],
    });
  });
});
