/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  FeatureName,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  overrideFeatureEnabled,
  StreamingMode,
} from '@google/adk';
import {createUserContent, FinishReason} from '@google/genai';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const mockForecastTool = new FunctionTool({
  name: 'showForecastChart',
  description: 'Show the forecast chart for a location',
  parameters: z.object({location: z.string()}),
  execute: (args) => `Forecast chart for ${args.location} shown.`,
});

/** Mock streaming responses representing a full tool back-and-forth. */
const MODEL_RESPONSES: RawGenerateContentResponse[] = [
  // LLM Call 1: mixed response containing text and tool call
  {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            {text: 'Let me show the forecast. '},
            {
              functionCall: {
                name: 'showForecastChart',
                args: {location: 'San Francisco'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      },
    ],
  },
  // LLM Call 2: post-tool final text answer
  {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            {text: 'Here is the forecast: it is sunny in San Francisco.'},
          ],
        },
        finishReason: FinishReason.STOP,
      },
    ],
  },
];

const USER_ID = 'test_user';

/** Runs the forecast agent once in SSE mode and collects the events. */
async function runForecastAgent(): Promise<{
  results: Event[];
  runner: InMemoryRunner;
  sessionId: string;
  appName: string;
}> {
  const sseAgent = new LlmAgent({
    name: 'sse_integration_agent',
    model: new GeminiWithMockResponses(MODEL_RESPONSES),
    instruction: 'You must call showForecastChart for San Francisco.',
    tools: [mockForecastTool],
  });

  const appName = sseAgent.name;
  const runner = new InMemoryRunner({agent: sseAgent, appName});
  const session = await runner.sessionService.createSession({
    appName,
    userId: USER_ID,
  });

  const results: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: session.id,
    newMessage: createUserContent('Show me the forecast.'),
    runConfig: {streamingMode: StreamingMode.SSE},
  })) {
    results.push(event);
  }

  return {results, runner, sessionId: session.id, appName};
}

describe('SSE Streaming Model Response Integration', () => {
  afterEach(() => {
    overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, undefined);
  });

  it('should preserve tool calls in session history event and successfully finish execution under StreamingMode.SSE', async () => {
    overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, false);

    const {results, runner, sessionId, appName} = await runForecastAgent();

    // Validate events yielded by the generator:
    // 0. Consolidated model text response event (non-progressive)
    // 1. Consolidated model tool call response event (non-progressive)
    // 2. System tool execution response event (from showForecastChart)
    // 3. Second LLM response (partial chunk)
    // 4. Second LLM response (final consolidated chunk)
    expect(results.length).toBe(5);

    // Validate the consolidated text event
    const textEvent = results[0];
    expect(textEvent.author).toBe('sse_integration_agent');
    expect(textEvent.content?.parts?.[0]?.text).toContain(
      'Let me show the forecast.',
    );
    expect(textEvent.partial).toBe(false);

    // Validate the consolidated tool call event
    const toolCallEvent = results[1];
    expect(toolCallEvent.author).toBe('sse_integration_agent');
    expect(toolCallEvent.content?.parts?.[0]?.functionCall).toBeDefined();
    expect(toolCallEvent.content?.parts?.[0]?.functionCall?.name).toBe(
      'showForecastChart',
    );
    expect(toolCallEvent.content?.parts?.[0]?.functionCall?.args).toEqual({
      location: 'San Francisco',
    });
    expect(toolCallEvent.partial).toBe(false);

    // Validate the tool execution response event matches the tool call response id
    const toolResponseEvent = results[2];
    expect(toolResponseEvent.author).toBe('sse_integration_agent'); // Handled in Context
    expect(
      toolResponseEvent.content?.parts?.[0]?.functionResponse,
    ).toBeDefined();
    expect(toolResponseEvent.content?.parts?.[0]?.functionResponse?.name).toBe(
      'showForecastChart',
    );
    expect(
      toolResponseEvent.content?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      result: 'Forecast chart for San Francisco shown.',
    });

    // Validate the final model text response
    const finalEventPartial = results[3];
    expect(finalEventPartial.author).toBe('sse_integration_agent');
    expect(finalEventPartial.content?.parts?.[0]?.text).toContain(
      'Here is the forecast: it is sunny in San Francisco.',
    );
    expect(finalEventPartial.partial).toBe(true);

    const finalEvent = results[4];
    expect(finalEvent.author).toBe('sse_integration_agent');
    expect(finalEvent.content?.parts?.[0]?.text).toContain(
      'Here is the forecast: it is sunny in San Francisco.',
    );
    expect(finalEvent.partial).toBe(false);

    // Fetch session history from DB and verify that the tool call is correctly saved
    const dbSession = await runner.sessionService.getSession({
      appName,
      userId: USER_ID,
      sessionId,
    });
    expect(dbSession).toBeDefined();

    // Events stored in DB should be:
    // 0. User prompt
    // 1. Consolidated model text response
    // 2. Consolidated model tool call response
    // 3. System tool execution response
    // 4. Final model text response
    expect(dbSession!.events.length).toBe(5);

    const dbToolCallEvent = dbSession!.events[2];
    expect(dbToolCallEvent.author).toBe('sse_integration_agent');
    expect(dbToolCallEvent.content?.parts?.[0]?.functionCall).toBeDefined();
    expect(dbToolCallEvent.content?.parts?.[0]?.functionCall?.name).toBe(
      'showForecastChart',
    );
  });

  it('should flush the first chunk as a partial event under the progressive default', async () => {
    const {results} = await runForecastAgent();

    // The progressive strategy flushes the first chunk as it arrives, so the
    // run yields one more event than the consolidated strategy does.
    expect(results.length).toBe(6);

    const flushedChunk = results[0];
    expect(flushedChunk.partial).toBe(true);
    expect(flushedChunk.content?.parts?.[0]?.text).toContain(
      'Let me show the forecast.',
    );
    expect(flushedChunk.content?.parts?.[1]?.functionCall?.name).toBe(
      'showForecastChart',
    );

    const consolidatedChunk = results[2];
    expect(consolidatedChunk.partial).toBe(false);
    expect(consolidatedChunk.content?.parts?.[0]?.text).toContain(
      'Let me show the forecast.',
    );
  });
});
