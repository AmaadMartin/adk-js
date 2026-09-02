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

/** Emits `count` events. */
class CountingAgent extends LlmAgent {
  constructor(private readonly count: number) {
    super({name: 'counting_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (let i = 0; i < this.count; i++) {
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
    const viaRun: string[] = [];
    for await (const event of newRunner(new CountingAgent(3)).run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
    })) {
      viaRun.push(`${event.author}:${event.content?.parts?.[0]?.text}`);
    }

    const viaRunAsync: string[] = [];
    for await (const event of newRunner(new CountingAgent(3)).runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
    })) {
      viaRunAsync.push(`${event.author}:${event.content?.parts?.[0]?.text}`);
    }

    expect(viaRun).toEqual(viaRunAsync);
    expect(viaRun).toHaveLength(3);
  });

  it('accepts the same options runAsync accepts', async () => {
    const events: Event[] = [];
    for await (const event of newRunner(new CountingAgent(1)).run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
      yieldUserMessage: true,
      runConfig: {customMetadata: {requestId: 'req-1'}},
    })) {
      events.push(event);
    }

    expect(events.map((e) => e.author)).toEqual(['user', 'counting_agent']);
    expect(events[0].customMetadata).toEqual({requestId: 'req-1'});
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

  it('re-throws a non-Error value unchanged, as runAsync does', async () => {
    await expect(async () => {
      for await (const _ of newRunner(new ThrowingAgent('cancelled')).run({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
      })) {
        // Drain until the failure surfaces.
      }
    }).rejects.toBe('cancelled');
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
});
