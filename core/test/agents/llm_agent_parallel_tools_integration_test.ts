/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  getFunctionResponses,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

/**
 * A minimal in-process model that replays canned responses. It exercises the
 * real agent/flow/runner pipeline (including handleFunctionCallsAsync) without
 * calling a real LLM. When it runs out of scripted responses it returns a plain
 * text response so the agent loop terminates deterministically.
 */
class ScriptedLlm extends BaseLlm {
  private callCount = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.responses[this.callCount] ?? {
      content: {role: 'model', parts: [{text: 'done'}]},
    };
    this.callCount++;
    yield response;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not supported by ScriptedLlm.');
  }
}

describe('LlmAgent parallel tool execution (runner integration)', () => {
  it('runs multiple tool calls and merges responses in call order with merged state', async () => {
    const appName = 'parallel_tools_integration';

    const weatherTool = new FunctionTool({
      name: 'get_weather',
      description: 'returns the weather',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        toolContext!.actions.stateDelta['weather'] = 'sunny';
        return {weather: 'sunny'};
      },
    });
    const newsTool = new FunctionTool({
      name: 'get_news',
      description: 'returns the news',
      parameters: z.object({}),
      execute: async (_args, toolContext) => {
        toolContext!.actions.stateDelta['news'] = 'quiet';
        return {news: 'quiet'};
      },
    });

    const parallelCallResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'get_weather', args: {}, id: 'call_weather'}},
          {functionCall: {name: 'get_news', args: {}, id: 'call_news'}},
        ],
      },
    };
    const finalResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'All done'}]},
    };

    const agent = new LlmAgent({
      name: 'root_agent',
      model: new ScriptedLlm([parallelCallResponse, finalResponse]),
      tools: [weatherTool, newsTool],
    });

    const runner = new InMemoryRunner({agent, appName});
    const session = await runner.sessionService.createSession({
      appName,
      userId: 'user_1',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session.id,
      newMessage: createUserContent('What is the weather and news?'),
    })) {
      events.push(event);
    }

    const responseEvent = events.find(
      (event) => getFunctionResponses(event).length > 0,
    );
    expect(responseEvent).toBeDefined();

    const responses = getFunctionResponses(responseEvent!);
    // Order matches the original call order regardless of completion order.
    expect(responses.map((response) => response.name)).toEqual([
      'get_weather',
      'get_news',
    ]);
    expect(responses.map((response) => response.id)).toEqual([
      'call_weather',
      'call_news',
    ]);
    expect(responses[0].response).toEqual({weather: 'sunny'});
    expect(responses[1].response).toEqual({news: 'quiet'});

    // The merged event carries the union of both tools' state deltas.
    expect(responseEvent!.actions!.stateDelta).toMatchObject({
      weather: 'sunny',
      news: 'quiet',
    });

    const updatedSession = await runner.sessionService.getSession({
      appName,
      userId: 'user_1',
      sessionId: session.id,
    });
    expect(updatedSession!.state).toMatchObject({
      weather: 'sunny',
      news: 'quiet',
    });
  });
});
