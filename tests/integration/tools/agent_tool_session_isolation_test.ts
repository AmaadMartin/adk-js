/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
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

describe('AgentTool session isolation', () => {
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
