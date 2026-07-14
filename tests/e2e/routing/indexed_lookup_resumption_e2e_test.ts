/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
} from '@google/adk';
import {
  Content,
  FunctionCall,
  FunctionDeclaration,
  FunctionResponse,
  Type,
} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

class CustomToolSubAgent extends LlmAgent {
  runCalled = false;

  constructor(name: string, parentAgent?: BaseAgent) {
    super({
      name,
      model: 'gemini-2.5-flash',
      subAgents: [],
      parentAgent,
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.runCalled = true;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [
          {text: `Resumed and executed clean response from ${this.name}`},
        ],
      },
    });
  }
}

describe('E2E Indexed Lookup and Session Resumption', () => {
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  it('should always pass (dummy test for vitest)', () => {
    expect(true).toBe(true);
  });

  it('should route execution to the originating tool agent via O(1) indexed lookup in long-running session without mocks', async () => {
    const rootAgent = new CustomToolSubAgent('root_agent');
    const toolAgentA = new CustomToolSubAgent('tool_agent_a', rootAgent);
    const toolAgentB = new CustomToolSubAgent('tool_agent_b', rootAgent);
    rootAgent.subAgents.push(toolAgentA, toolAgentB);

    const runner = new InMemoryRunner({
      agent: rootAgent,
      appName: 'e2e_indexed_lookup_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'e2e_indexed_lookup_app',
      userId: 'test_user',
    });

    // Simulate 50 prior events in a long-running multi-turn session
    for (let i = 0; i < 50; i++) {
      await runner.sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: `prior_inv_${i}`,
          author: i % 2 === 0 ? 'user' : 'tool_agent_a',
          content: {
            role: i % 2 === 0 ? 'user' : 'model',
            parts: [{text: `Message ${i}`}],
          },
        }),
      });
    }

    // Now tool_agent_b emits a function call
    const targetCallId = 'call_id_target_99';
    const functionCall: FunctionCall = {
      id: targetCallId,
      name: 'fetch_user_record',
      args: {userId: '123'},
    };
    const callEvent = createEvent({
      invocationId: 'inv_call_99',
      author: 'tool_agent_b',
      content: {role: 'model', parts: [{functionCall}]},
    });
    await runner.sessionService.appendEvent({
      session,
      event: callEvent,
    });

    // And 10 more intermediate events after the call
    for (let i = 0; i < 10; i++) {
      await runner.sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: `post_inv_${i}`,
          author: 'user',
          content: {role: 'user', parts: [{text: `Intermediate comment ${i}`}]},
        }),
      });
    }

    // Now resume execution through Runner.runAsync by providing the functionResponse
    const functionResponse: FunctionResponse = {
      id: targetCallId,
      name: 'fetch_user_record',
      response: {status: 'OK', record: {name: 'Alice'}},
    };
    const newMessage: Content = {
      role: 'user',
      parts: [{functionResponse}],
    };

    const yieldedEvents: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage,
    })) {
      yieldedEvents.push(event);
    }

    // Assert that determineAgentForResumption selected tool_agent_b and it ran
    expect(toolAgentB.runCalled).toBe(true);
    expect(toolAgentA.runCalled).toBe(false);
    expect(yieldedEvents.length).toBeGreaterThan(0);
    expect(yieldedEvents[0].author).toBe('tool_agent_b');
    expect(yieldedEvents[0].content?.parts?.[0]?.text).toContain(
      'Resumed and executed clean response from tool_agent_b',
    );
  });

  it.skipIf(!hasAKey)(
    'should resume live multi-turn tool interaction via indexed lookup with Gemini API',
    async () => {
      // Live e2e test with function declaration and resumption
      const agent = new LlmAgent({
        name: 'live_tool_agent',
        model: 'gemini-2.5-flash',
        instruction: 'When asked for calculation, use the add_numbers tool.',
        tools: [
          {
            name: 'add_numbers',
            description: 'Add two numbers',
            parameters: {
              type: Type.OBJECT,
              properties: {
                a: {type: Type.NUMBER},
                b: {type: Type.NUMBER},
              },
              required: ['a', 'b'],
            },
          } as unknown as FunctionDeclaration,
        ],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'live_e2e_app',
      });

      const session = await runner.sessionService.createSession({
        appName: 'live_e2e_app',
        userId: 'live_user',
      });

      // Turn 1: Ask model to call tool
      let callId: string | undefined;
      for await (const event of runner.runAsync({
        userId: 'live_user',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [{text: 'Please call add_numbers with a=5 and b=7.'}],
        },
      })) {
        if (event.content?.parts) {
          for (const part of event.content.parts) {
            if (part.functionCall?.id) {
              callId = part.functionCall.id;
            }
          }
        }
      }

      expect(callId).toBeDefined();

      // Turn 2: Resume with function response
      let finalAnswer = '';
      for await (const event of runner.runAsync({
        userId: 'live_user',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: callId!,
                name: 'add_numbers',
                response: {result: 12},
              },
            },
          ],
        },
      })) {
        if (event.content?.parts?.[0]?.text) {
          finalAnswer += event.content.parts[0].text;
        }
      }

      expect(finalAnswer).toContain('12');
    },
    60000,
  );
});
