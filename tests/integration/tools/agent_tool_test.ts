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
  Session,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const APP_NAME = 'ADKTest';
const USER_ID = 'TestUser';
const SESSION_ID = '1';

function textReply(text: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {parts: [{text}], role: 'model'},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

function toolCall(id: string, request: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          parts: [{functionCall: {name: 'subAgent', args: {request}, id}}],
          role: 'model',
        },
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/** The text of every model turn the parent agent produced. */
function modelTexts(session: Session): string[] {
  return session.events
    .filter((event) => event.content?.role === 'model')
    .flatMap((event) => event.content?.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => text !== undefined);
}

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

  it('runs the sub-agent twice without writing to the parent session service', async () => {
    const subAgent = new LlmAgent({
      model: new GeminiWithMockResponses([
        textReply('Today is Tuesday'),
        textReply('Tomorrow is Wednesday'),
      ]),
      name: 'subAgent',
      description: 'answers calendar questions',
      instruction: 'answer the question',
    });

    const mainAgent = new LlmAgent({
      model: new GeminiWithMockResponses([
        toolCall('adk-mock-call-1', 'what day is today'),
        toolCall('adk-mock-call-2', 'what day is tomorrow'),
        textReply('Tuesday, then Wednesday.'),
      ]),
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'use subAgent to answer',
      tools: [new AgentTool({agent: subAgent})],
    });

    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const runner = new Runner({
      appName: APP_NAME,
      agent: mainAgent,
      sessionService,
    });

    for await (const _event of runner.runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'What day is it?'}]},
    })) {
      // Consume the events.
    }

    const listed = await sessionService.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });
    expect(listed.sessions.map((session) => session.id)).toEqual([SESSION_ID]);

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(session).toBeDefined();

    const texts = modelTexts(session!);
    expect(texts).toContain('Tuesday, then Wednesday.');

    const responses = session!.events
      .flatMap((event) => event.content?.parts ?? [])
      .map((part) => part.functionResponse?.response)
      .filter((response) => response !== undefined);
    expect(responses).toEqual([
      {result: 'Today is Tuesday'},
      {result: 'Tomorrow is Wednesday'},
    ]);
  });
});
