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
  Runner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'run_app';
const USER_ID = 'u1';
const SESSION_ID = 's1';
const HELLO = {role: 'user', parts: [{text: 'hello'}]};

/** Emits `count` events, recording how many it has produced so far. */
class CountingAgent extends BaseAgent {
  produced = 0;

  constructor(private readonly count: number) {
    super({name: 'counting_agent'});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (let i = 0; i < this.count; i++) {
      this.produced++;
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: `event ${i}`}]},
      });
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

/** Emits one event, then fails. */
class FailingAgent extends BaseAgent {
  constructor() {
    super({name: 'failing_agent'});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'before the failure'}]},
    });
    throw new Error('agent exploded');
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

async function newRunner(agent: BaseAgent): Promise<Runner> {
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  return new Runner({appName: APP_NAME, agent, sessionService});
}

function text(event: Event): string | undefined {
  return event.content?.parts?.[0]?.text;
}

describe('Runner.run', () => {
  it('yields the same events runAsync would, in order', async () => {
    const runner = await newRunner(new CountingAgent(3));

    const events: Event[] = [];
    for await (const event of runner.run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: HELLO,
    })) {
      events.push(event);
    }

    expect(events.map(text)).toEqual(['event 0', 'event 1', 'event 2']);
  });

  it('applies the state delta to the appended user event', async () => {
    const runner = await newRunner(new CountingAgent(1));

    for await (const _ of runner.run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: HELLO,
      stateDelta: {seen: true},
    })) {
      // drain
    }

    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const userEvent = session?.events.find((e) => e.author === 'user');
    expect(userEvent?.actions.stateDelta).toEqual({seen: true});
  });

  it('reports the agent failure after the events that preceded it', async () => {
    const runner = await newRunner(new FailingAgent());
    const events: Event[] = [];

    await expect(
      (async () => {
        for await (const event of runner.run({
          userId: USER_ID,
          sessionId: SESSION_ID,
          newMessage: HELLO,
        })) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow('agent exploded');

    expect(events.map(text)).toEqual(['before the failure']);
  });

  it('reports a failure raised before any event', async () => {
    const runner = await newRunner(new CountingAgent(1));

    await expect(
      (async () => {
        for await (const _ of runner.run({
          userId: USER_ID,
          sessionId: 'no_such_session',
          newMessage: HELLO,
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow('Session not found: no_such_session');
  });

  it('raises nothing when the caller stops iterating early', async () => {
    const runner = await newRunner(new FailingAgent());
    const seen: Event[] = [];

    // The agent fails after its first event; leaving the loop before the
    // failure must not surface it.
    for await (const event of runner.run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: HELLO,
    })) {
      seen.push(event);
      break;
    }

    expect(seen.map(text)).toEqual(['before the failure']);
  });

  it('keeps producing while the consumer holds an event', async () => {
    const agent = new CountingAgent(5);
    const runner = await newRunner(agent);

    const events = runner.run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: HELLO,
    });
    const first = await events.next();
    if (first.done) {
      expect.fail('run() ended before yielding an event');
    }
    expect(text(first.value)).toBe('event 0');

    // Let the producer run while this consumer is not pulling.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.produced).toBe(5);

    await events.return();
  });

  it('throttles runAsync to the consumer, unlike run', async () => {
    const agent = new CountingAgent(5);
    const runner = await newRunner(agent);

    const events = runner.runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: HELLO,
    });
    await events.next();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.produced).toBe(1);

    await events.return();
  });
});
