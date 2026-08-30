/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `single_turn` sub-agent runs inline in the caller's invocation, which is
 * the opposite of what `AgentTool` does: no nested runner, no separate session.
 * These cases drive the whole path through a real `Runner`.
 */

import {
  Event,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  Runner,
  getFunctionResponses,
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
const FUNCTION_CALL_ID = 'adk-mock-call-1';

function modelText(text: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {parts: [{text}], role: 'model'},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

function modelCall(name: string, args: Record<string, unknown>) {
  return {
    candidates: [
      {
        content: {
          parts: [{functionCall: {name, args, id: FUNCTION_CALL_ID}}],
          role: 'model',
        },
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

describe('single_turn sub-agent delegation', () => {
  it('runs the sub-agent in the caller session and answers from its output', async () => {
    const translator = new LlmAgent({
      model: new GeminiWithMockResponses([modelText('hola')]),
      name: 'translator',
      description: 'Translates the input text to Spanish.',
      mode: 'single_turn',
    });
    const requests: LlmRequest[] = [];
    const writer = new LlmAgent({
      model: new GeminiWithMockResponses([
        modelCall('translator', {request: 'hello'}),
        modelText('In Spanish that is hola.'),
      ]),
      name: 'writer',
      description: 'Writes text and has it translated.',
      instruction: 'Use the translator tool.',
      subAgents: [translator],
      beforeModelCallback: ({request}) => {
        requests.push(request);
        return undefined;
      },
    });

    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent: writer,
      sessionService,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Say hello in Spanish.'}]},
    })) {
      events.push(event);
    }

    // The model was offered the sub-agent as a tool, not as a transfer target.
    expect(writer.tools).toHaveLength(1);
    expect(requests).not.toHaveLength(0);
    for (const request of requests) {
      expect(Object.keys(request.toolsDict)).toContain('translator');
      expect(Object.keys(request.toolsDict)).not.toContain('transfer_to_agent');
      expect(request.config?.systemInstruction).not.toContain(
        'Agent name: translator',
      );
    }

    // The sub-agent ran inline: its turn is in the caller's own session, on a
    // branch scoped to the function call.
    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const translatorEvents = (session?.events ?? []).filter(
      (event) => event.author === 'translator',
    );
    expect(translatorEvents).not.toHaveLength(0);
    for (const event of translatorEvents) {
      expect(event.branch).toBe(`translator@${FUNCTION_CALL_ID}`);
    }

    // The coordinator received the sub-agent output as the function response,
    // and answered from it.
    const responses = events.flatMap((event) => getFunctionResponses(event));
    expect(responses).toHaveLength(1);
    expect(responses[0].name).toBe('translator');
    expect(responses[0].response).toEqual({result: 'hola'});
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe(
      'In Spanish that is hola.',
    );
  });

  it('reports a sub-agent failure to the model instead of ending the turn', async () => {
    const translator = new LlmAgent({
      model: new GeminiWithMockResponses([]),
      name: 'translator',
      description: 'Translates the input text to Spanish.',
      mode: 'single_turn',
    });
    const writer = new LlmAgent({
      model: new GeminiWithMockResponses([
        modelCall('translator', {request: 'hello'}),
        modelText('The translator is unavailable.'),
      ]),
      name: 'writer',
      description: 'Writes text and has it translated.',
      instruction: 'Use the translator tool.',
      subAgents: [translator],
    });

    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent: writer,
      sessionService,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Say hello in Spanish.'}]},
    })) {
      events.push(event);
    }

    const responses = events.flatMap((event) => getFunctionResponses(event));
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({
      result: expect.stringContaining('Error running sub-agent:'),
    });
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe(
      'The translator is unavailable.',
    );
  });
});
