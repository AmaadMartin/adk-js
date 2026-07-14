/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  getLogger,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

class E2eLlmAgent extends LlmAgent {
  constructor(name: string, parentAgent?: LlmAgent) {
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
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [
          {
            text: `Response from ${this.name} in session ${context.session?.id}`,
          },
        ],
      },
    });
  }
}

describe('E2E Session Resumption for Long-Running Sessions', () => {
  it('should resume session with 500+ turns cleanly without event JSON spam', async () => {
    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const rootAgent = new E2eLlmAgent('root_orchestrator');
    const specializedAgent1 = new E2eLlmAgent('specialized_agent_1', rootAgent);
    const specializedAgent2 = new E2eLlmAgent('specialized_agent_2', rootAgent);
    rootAgent.subAgents.push(specializedAgent1, specializedAgent2);

    const runner = new Runner({
      appName: 'e2e_resumption_app',
      agent: rootAgent,
      sessionService,
      artifactService,
    });

    // Create session and initiate multi-turn conversation
    const session = await sessionService.createSession({
      appName: 'e2e_resumption_app',
      userId: 'e2e_user',
      sessionId: 'session_long_500',
    });

    // Append 500+ turns of interaction history across sub-agents
    for (let i = 0; i < 550; i++) {
      const author = i % 2 === 0 ? 'specialized_agent_1' : 'user';
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: `inv_history_${i}`,
          author,
          content: {
            role: i % 2 === 0 ? 'model' : 'user',
            parts: [{text: `Historical conversation turn ${i}`}],
          },
        }),
      });
    }

    // Append last turn from specialized_agent_2
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv_history_final',
        author: 'specialized_agent_2',
        content: {
          role: 'model',
          parts: [{text: 'Final historical turn from specialized agent 2'}],
        },
      }),
    });

    const spyInfo = vi.spyOn(getLogger(), 'info');
    const spyDebug = vi.spyOn(getLogger(), 'debug');

    // Invoke runAsync with a new user message on the existing session
    const resumedEvents: Event[] = [];
    const startTime = Date.now();
    for await (const event of runner.runAsync({
      userId: 'e2e_user',
      sessionId: 'session_long_500',
      newMessage: {
        role: 'user',
        parts: [{text: 'Resume and continue processing'}],
      },
    })) {
      resumedEvents.push(event);
    }
    const durationMs = Date.now() - startTime;

    // Verify resumption routed cleanly to specialized_agent_2
    expect(resumedEvents.length).toBeGreaterThan(0);
    expect(resumedEvents[0].author).toBe('specialized_agent_2');
    expect(spyInfo).not.toHaveBeenCalled();
    expect(spyDebug).toHaveBeenCalledWith(
      expect.stringContaining('specialized_agent_2'),
    );
    expect(durationMs).toBeLessThan(5000);

    spyInfo.mockRestore();
    spyDebug.mockRestore();
  });
});
