/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event, InMemoryRunner, LlmAgent} from '@google/adk';
import {FinishReason, FunctionCall, FunctionResponse} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

describe('Integration: Runner Resumption for LRO and Fallback Routing', () => {
  it('should resume subagent handling LRO/EUC credential request on function response', async () => {
    const lroCall: FunctionCall = {
      id: 'lro-call-999',
      name: 'request_euc_credential',
      args: {reason: 'need auth'},
    };

    const turn2Response: RawGenerateContentResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{text: 'LRO completed and verified'}],
          },
          finishReason: FinishReason.STOP,
        },
      ],
    };

    const subAgentLro = new LlmAgent({
      name: 'sub_agent_lro',
      model: new GeminiWithMockResponses([turn2Response]),
      description: 'Sub agent for LRO and credential requests',
    });

    const rootAgent = new LlmAgent({
      name: 'root_agent',
      model: new GeminiWithMockResponses([]),
      subAgents: [subAgentLro],
      description: 'Root coordinator',
    });

    const runner = new InMemoryRunner({
      agent: rootAgent,
      appName: 'test_app_lro',
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_app_lro',
      userId: 'user_1',
    });

    // Simulate prior turn where sub_agent_lro yielded function call for LRO
    const lroEvent = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent_lro',
      content: {role: 'model', parts: [{functionCall: lroCall}]},
    });
    await runner.sessionService.appendEvent({session, event: lroEvent});

    // Simulate turn 2: User provides function response to complete LRO
    const lroResponse: FunctionResponse = {
      id: 'lro-call-999',
      name: 'request_euc_credential',
      response: {status: 'SUCCESS', token: 'mock-token'},
    };

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{functionResponse: lroResponse}]},
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].author).toBe('sub_agent_lro');
    expect(events[0].content?.parts?.[0].text).toBe(
      'LRO completed and verified',
    );
  });
});
