/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `test_grounding_metadata_is_not_stored_in_state_after_invocation`, ported
 * from `adk-python main —
 * tests/unittests/tools/test_google_search_agent_tool.py`, plus the
 * multi-tool turn the workaround exists for.
 */

import type {Event} from '@google/adk';
import {
  createGoogleSearchAgent,
  FunctionTool,
  getFunctionResponses,
  GoogleSearchAgentTool,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {FinishReason, GroundingMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const APP_NAME = 'ADKTest';
const USER_ID = 'TestUser';
const SESSION_ID = '1';
const GROUNDING_METADATA_KEY = 'temp:_adk_grounding_metadata';

const GROUNDING_METADATA: GroundingMetadata = {
  webSearchQueries: ['test query'],
};

function textResponse(
  text: string,
  groundingMetadata?: GroundingMetadata,
): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {parts: [{text}], role: 'model'},
        finishReason: FinishReason.STOP,
        groundingMetadata,
      },
    ],
  };
}

function functionCallResponse(
  calls: Array<{name: string; args: Record<string, unknown>; id: string}>,
): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          parts: calls.map((functionCall) => ({functionCall})),
          role: 'model',
        },
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/**
 * The persisted state keys that hold grounding metadata. Matches on the key
 * suffix, so the assertion still bites if the `temp:` prefix goes missing and
 * the key starts surviving the session write.
 */
function groundingKeysOf(state: Record<string, unknown>): string[] {
  return Object.keys(state).filter((key) =>
    key.endsWith('_adk_grounding_metadata'),
  );
}

/** Drives `rootAgent` for one turn and returns the events and the session. */
async function runOneTurn(rootAgent: LlmAgent, prompt: string) {
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });

  const runner = new Runner({
    appName: APP_NAME,
    agent: rootAgent,
    sessionService,
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: [{text: prompt}]},
  })) {
    events.push(event);
  }

  const session = await sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });

  return {events, session};
}

describe('GoogleSearchAgentTool', () => {
  it('test_grounding_metadata_is_not_stored_in_state_after_invocation', async () => {
    const searchAgent = createGoogleSearchAgent(
      new GeminiWithMockResponses([
        textResponse('response from tool', GROUNDING_METADATA),
      ]),
    );

    const rootAgent = new LlmAgent({
      name: 'root_agent',
      model: new GeminiWithMockResponses([
        functionCallResponse([
          {
            name: 'google_search_agent',
            args: {request: 'test1'},
            id: 'adk-mock-call-1',
          },
        ]),
        textResponse('Final response from root'),
      ]),
      tools: [new GoogleSearchAgentTool(searchAgent)],
    });

    const {events, session} = await runOneTurn(rootAgent, 'test input');

    const responses = events.flatMap((event) => getFunctionResponses(event));
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({result: 'response from tool'});

    expect(session).toBeDefined();
    expect(session!.state).not.toHaveProperty(GROUNDING_METADATA_KEY);
    expect(groundingKeysOf(session!.state)).toEqual([]);
  });

  it('answers a turn that calls the search agent and a function tool', async () => {
    const searchAgent = createGoogleSearchAgent(
      new GeminiWithMockResponses([
        textResponse('Paris is the capital of France.', GROUNDING_METADATA),
      ]),
    );

    const rootAgent = new LlmAgent({
      name: 'root_agent',
      model: new GeminiWithMockResponses([
        functionCallResponse([
          {
            name: 'google_search_agent',
            args: {request: 'capital of France'},
            id: 'adk-mock-call-1',
          },
          {
            name: 'get_time_zone',
            args: {city: 'Paris'},
            id: 'adk-mock-call-2',
          },
        ]),
        textResponse('Paris is the capital of France, in CET.'),
      ]),
      tools: [
        new GoogleSearchAgentTool(searchAgent),
        new FunctionTool({
          name: 'get_time_zone',
          description: 'Returns the time zone of a city.',
          parameters: z.object({city: z.string()}),
          execute: async ({city}) => ({city, timeZone: 'CET'}),
        }),
      ],
    });

    const {events, session} = await runOneTurn(
      rootAgent,
      'What is the capital of France and what time zone is it in?',
    );

    const responses = events.flatMap((event) => getFunctionResponses(event));
    expect(responses.map((response) => response.name)).toEqual([
      'google_search_agent',
      'get_time_zone',
    ]);
    expect(responses[0].response).toEqual({
      result: 'Paris is the capital of France.',
    });
    expect(responses[1].response).toEqual({city: 'Paris', timeZone: 'CET'});

    expect(session).toBeDefined();
    expect(session!.state).not.toHaveProperty(GROUNDING_METADATA_KEY);
    expect(groundingKeysOf(session!.state)).toEqual([]);
  });
});
