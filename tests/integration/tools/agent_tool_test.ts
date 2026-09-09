/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

describe('AgentTool', () => {
  it('propagates state changes from sub-agent to parent session', async () => {
    const mockSubAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Today is Tuesday'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const mockParentAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'subAgent',
                    args: {request: 'what day is today'},
                    id: 'adk-mock-call-1',
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
              parts: [{text: 'The subAgent says it is Tuesday.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const subAgentModel = new GeminiWithMockResponses(mockSubAgentResponses);
    const subAgent = new LlmAgent({
      model: subAgentModel,
      name: 'subAgent',
      description: 'subAgent',
      instruction: 'answer what day is today',
      outputKey: 'subAgentOutput',
    });

    const mainAgentModel = new GeminiWithMockResponses(
      mockParentAgentResponses,
    );
    const mainAgent = new LlmAgent({
      model: mainAgentModel,
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'testing you must use subAgent to answer',
      tools: [new AgentTool({agent: subAgent})],
    });

    const sessionService = new InMemorySessionService();
    const memoryService = new InMemoryMemoryService();

    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
      state: {initialStateKey: 'contexto inicial'},
    });

    const runner = new Runner({
      appName: 'ADKTest',
      agent: mainAgent,
      sessionService,
      memoryService,
    });

    const runOptions = {
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {
        role: 'user',
        parts: [{text: 'What day is today?'}],
      },
    };

    for await (const _event of runner.runAsync(runOptions)) {
      // Consume the events.
    }

    const session = await sessionService.getSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });

    expect(session).toBeDefined();
    expect(session!.state['initialStateKey']).toBe('contexto inicial');
    expect(session!.state['subAgentOutput']).toBe('Today is Tuesday');
  });
  it('validates the schema-typed sub-agent call in both directions', async () => {
    const subAgentModel = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              parts: [{text: '{"summary": "three pairs found", "count": 3}'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ]);
    const requestedTexts: string[] = [];
    const subAgent = new LlmAgent({
      model: subAgentModel,
      name: 'searchAgent',
      description: 'searches the catalogue',
      instruction: 'search the catalogue',
      inputSchema: z.object({query: z.string(), limit: z.number()}),
      outputSchema: z.object({summary: z.string(), count: z.number()}),
      beforeModelCallback: ({request}) => {
        for (const content of request.contents ?? []) {
          for (const part of content.parts ?? []) {
            if (part.text) {
              requestedTexts.push(part.text);
            }
          }
        }
        return undefined;
      },
    });

    const mainAgentModel = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'searchAgent',
                    args: {query: 'running shoes', limit: 3},
                    id: 'adk-mock-call-1',
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
              parts: [{text: 'I found three pairs.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ]);
    const mainAgent = new LlmAgent({
      model: mainAgentModel,
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'use searchAgent to answer',
      tools: [new AgentTool({agent: subAgent})],
    });

    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });
    const runner = new Runner({
      appName: 'ADKTest',
      agent: mainAgent,
      sessionService,
      memoryService: new InMemoryMemoryService(),
    });

    const responses: unknown[] = [];
    for await (const event of runner.runAsync({
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {role: 'user', parts: [{text: 'Find me running shoes'}]},
    })) {
      for (const part of event.content?.parts ?? []) {
        if (part.functionResponse) {
          responses.push(part.functionResponse.response);
        }
      }
    }

    expect(requestedTexts).toContain('{"query":"running shoes","limit":3}');
    expect(responses).toEqual([{summary: 'three pairs found', count: 3}]);
  });
});
