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
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MultiTurnMockAgent extends BaseAgent {
  constructor(name = 'multi_turn_mock_agent') {
    super({name});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const turnCount =
      Math.floor((context.session?.events?.length || 0) / 2) + 1;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: `Response for turn ${turnCount}`}],
      },
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

describe('Integration: InMemoryRunner internalized config multi-turn workflow', () => {
  it('should maintain conversation history across multiple turns without re-specifying userId and sessionId', async () => {
    const agent = new MultiTurnMockAgent();
    const userId = 'int-user-123';
    const sessionId = 'int-session-456';

    const runner = new InMemoryRunner({
      agent,
      userId,
      sessionId,
    });

    await runner.sessionService.createSession({
      appName: runner.appName,
      userId,
      sessionId,
    });

    const turn1Events: Event[] = [];
    for await (const event of runner.runAsync({
      newMessage: {role: 'user', parts: [{text: 'Hello turn 1'}]},
    })) {
      turn1Events.push(event);
    }
    expect(turn1Events.length).toBeGreaterThan(0);

    const sessionAfterTurn1 = await runner.sessionService.getSession({
      appName: runner.appName,
      userId,
      sessionId,
    });
    expect(sessionAfterTurn1).toBeDefined();
    expect(sessionAfterTurn1!.events.length).toBe(2);
    expect(sessionAfterTurn1!.events[0].content?.parts?.[0]?.text).toBe(
      'Hello turn 1',
    );
    expect(sessionAfterTurn1!.events[1].content?.parts?.[0]?.text).toBe(
      'Response for turn 1',
    );

    const turn2Events: Event[] = [];
    for await (const event of runner.runAsync({
      newMessage: {role: 'user', parts: [{text: 'Hello turn 2'}]},
    })) {
      turn2Events.push(event);
    }
    expect(turn2Events.length).toBeGreaterThan(0);

    const sessionAfterTurn2 = await runner.sessionService.getSession({
      appName: runner.appName,
      userId,
      sessionId,
    });
    expect(sessionAfterTurn2).toBeDefined();
    expect(sessionAfterTurn2!.events.length).toBe(4);
    expect(sessionAfterTurn2!.events[2].content?.parts?.[0]?.text).toBe(
      'Hello turn 2',
    );
    expect(sessionAfterTurn2!.events[3].content?.parts?.[0]?.text).toBe(
      'Response for turn 2',
    );
  });
});
