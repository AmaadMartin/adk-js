/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'run_app';
const USER_ID = 'run_user';
const SESSION_ID = 'run_session';
const MESSAGE = {role: 'user', parts: [{text: 'hello'}]};

/** Emits `count` events and records how many it has emitted so far. */
class CountingAgent extends LlmAgent {
  emitted = 0;

  constructor(private readonly count: number) {
    super({name: 'counting_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (let i = 0; i < this.count; i++) {
      this.emitted++;
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: `event ${i}`}]},
      });
    }
  }
}

/** Emits one event, then throws the given value. */
class ThrowingAgent extends LlmAgent {
  constructor(private readonly thrown: unknown) {
    super({name: 'throwing_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'before the failure'}]},
    });
    throw this.thrown;
  }
}

describe('Runner.run', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  function newRunner(agent: BaseAgent): Runner {
    return new Runner({appName: APP_NAME, agent, sessionService});
  }

  it('forwards stateDelta to the persisted user event', async () => {
    const runner = newRunner(new CountingAgent(1));

    for await (const _ of runner.run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
      stateDelta: {answer: 42},
    })) {
      // Drain the run.
    }

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const userEvent = session?.events.find((e) => e.author === 'user');
    expect(userEvent?.actions?.stateDelta).toEqual({answer: 42});
  });

  it('yields the same events in the same order as runAsync', async () => {
    const eager: string[] = [];
    for await (const event of newRunner(new CountingAgent(3)).run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
    })) {
      eager.push(`${event.author}:${event.content?.parts?.[0]?.text}`);
    }

    const lazy: string[] = [];
    for await (const event of newRunner(new CountingAgent(3)).runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
    })) {
      lazy.push(`${event.author}:${event.content?.parts?.[0]?.text}`);
    }

    expect(eager).toEqual(lazy);
    expect(eager).toHaveLength(3);
  });

  it('runs the agent ahead of a slow consumer', async () => {
    const agent = new CountingAgent(4);
    const emittedAtFirstEvent: number[] = [];

    for await (const _ of newRunner(agent).run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
    })) {
      emittedAtFirstEvent.push(agent.emitted);
      // Let the pump run while the consumer is busy.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(emittedAtFirstEvent).toHaveLength(4);
    // By the time the second event reaches the consumer the agent has already
    // produced everything; runAsync would still be at event two.
    expect(emittedAtFirstEvent[1]).toBe(4);
  });

  it('does not run ahead under runAsync', async () => {
    const agent = new CountingAgent(4);
    const emittedAtEachEvent: number[] = [];

    for await (const _ of newRunner(agent).runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
    })) {
      emittedAtEachEvent.push(agent.emitted);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(emittedAtEachEvent).toEqual([1, 2, 3, 4]);
  });

  it('yields the events produced before an error, then re-throws it', async () => {
    const failure = new Error('agent exploded');
    const received: Event[] = [];

    await expect(async () => {
      for await (const event of newRunner(new ThrowingAgent(failure)).run({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
      })) {
        received.push(event);
      }
    }).rejects.toBe(failure);

    expect(received).toHaveLength(1);
    expect(received[0].content?.parts?.[0]?.text).toBe('before the failure');
  });

  it('wraps a non-Error throw and keeps it as the cause', async () => {
    let caught: unknown;
    try {
      for await (const _ of newRunner(new ThrowingAgent('cancelled')).run({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
      })) {
        // Drain until the failure surfaces.
      }
    } catch (thrown) {
      caught = thrown;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Agent run terminated by cancelled.',
    );
    expect((caught as Error).cause).toBe('cancelled');
  });

  it('describes a non-string, non-Error throw by its type', async () => {
    let caught: unknown;
    try {
      for await (const _ of newRunner(new ThrowingAgent({code: 7})).run({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
      })) {
        // Drain until the failure surfaces.
      }
    } catch (thrown) {
      caught = thrown;
    }

    expect((caught as Error).message).toBe('Agent run terminated by object.');
    expect((caught as Error).cause).toEqual({code: 7});
  });

  it('raises nothing when the caller stops iterating before the failure', async () => {
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', record);

    try {
      for await (const _ of newRunner(new ThrowingAgent(new Error('boom'))).run(
        {
          userId: USER_ID,
          sessionId: SESSION_ID,
          newMessage: MESSAGE,
        },
      )) {
        break;
      }
      // Give any stray rejection a turn to surface.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(rejections).toEqual([]);
  });

  it('never drops an event when the buffer fills', async () => {
    // MAX_BUFFERED_RUN_EVENTS is 1000, so this run exceeds the bound and the
    // pump has to wait for the consumer at least once.
    const received: Event[] = [];
    for await (const event of newRunner(new CountingAgent(1200)).run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
    })) {
      received.push(event);
    }

    expect(received).toHaveLength(1200);
    expect(received[1199].content?.parts?.[0]?.text).toBe('event 1199');
  });
});
